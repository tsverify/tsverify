/**
 * Loads the TypeScript project once (no emit) in a TypeScript 7 compiler process
 * (`compiler.ts`) and gives the analysis modules a context: the probed program, its checker, and
 * original-file source locations.
 *
 * Order matters (X1): `loadProject` → syntactic write discovery over `files` → `planNarrowing`
 * → only then `ProjectContext` (the first type query happens in its constructor).
 *
 * Uses the TypeScript installed by `useTypeScript` (`typescript.ts`). The caller closes the
 * loaded project (`close()`), which ends the compiler process.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { SourceLocation } from "@tsverify/ir";
import { CompilerSession } from "./compiler";
import { TypeScriptSetupError } from "./load-typescript";
import type * as TS from "./ts-types";
import { ProgramTypeFacts } from "./type-facts";
import { typescript } from "./typescript";

export interface LoadedProject {
  /** Absolute project root, `/`-separated, no trailing slash. */
  root: string;
  /**
   * Original (unprobed) source files under analysis, sorted by path: the tsconfig's files and
   * every file they import, minus declarations and `node_modules`.
   */
  files: TS.SourceFile[];
  facts: ProgramTypeFacts;
  /** Ends the compiler process. Safe to call more than once. */
  close(): void;
}

export interface LoadError {
  error: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Declaration file names (`.d.ts`, `.d.mts`, `.d.cts`, `.d.css.ts`): never analyzed. */
const DECLARATION_FILE = /\.d\.([^/.]+\.)?[cm]?ts$/;

/** Files the extractor analyzes: project files that are neither declarations nor deps. */
function isAnalyzedName(fileName: string): boolean {
  return !DECLARATION_FILE.test(fileName) && !fileName.includes("/node_modules/");
}

export function loadProject(projectRoot: string, tsconfig?: string): LoadedProject | LoadError {
  const root = toPosix(path.resolve(projectRoot)).replace(/\/$/, "");
  const configPath = toPosix(
    tsconfig === undefined ? path.join(root, "tsconfig.json") : path.resolve(root, tsconfig),
  );
  if (!existsSync(configPath)) {
    return {
      error:
        tsconfig === undefined
          ? `no tsconfig.json in the project directory ${root}`
          : `no tsconfig at ${configPath}`,
    };
  }
  let session: CompilerSession;
  try {
    session = new CompilerSession(typescript, root, configPath);
  } catch (error) {
    throw new TypeScriptSetupError(
      `TypeScript ${typescript.version} could not start its compiler: ${(error as Error).message}`,
    );
  }
  try {
    const base = session.open();
    // Project references are not followed: imports of a referenced project resolve to its
    // sources, which the extractor can read, rather than to its built declarations.
    const files: TS.SourceFile[] = [];
    for (const name of [...base.program.getSourceFileNames()].sort()) {
      if (!isAnalyzedName(name)) continue;
      const sf = base.program.getSourceFile(name);
      if (sf && !sf.isDeclarationFile) files.push(sf);
    }
    files.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
    return {
      root,
      files,
      facts: new ProgramTypeFacts(session, base),
      close: () => session.close(),
    };
  } catch (error) {
    session.close();
    throw error;
  }
}

/** Analysis context over the probed program. Constructing it performs the first type query. */
export class ProjectContext {
  readonly checker: TS.Checker;
  readonly program: TS.Program;
  readonly root: string;
  readonly facts: ProgramTypeFacts;
  private readonly originals: Map<string, TS.SourceFile>;

  constructor(loaded: LoadedProject) {
    this.root = loaded.root;
    this.facts = loaded.facts;
    this.originals = new Map(loaded.files.map((sf) => [sf.fileName, sf]));
    this.program = loaded.facts.program;
    this.checker = loaded.facts.checker;
  }

  /** The probed source file for an absolute path, if the program has it. */
  sourceFile(absPath: string): TS.SourceFile | undefined {
    return this.program.getSourceFile(absPath);
  }

  /** Probed source files under analysis, in path order. */
  analyzedFiles(): TS.SourceFile[] {
    const out: TS.SourceFile[] = [];
    for (const name of this.originals.keys()) {
      const sf = this.program.getSourceFile(name);
      if (sf) out.push(sf);
    }
    return out;
  }

  isAnalyzed(sf: TS.SourceFile): boolean {
    return this.originals.has(sf.fileName);
  }

  /** Project-root-relative, `/`-separated path. */
  rel(fileName: string): string {
    return path.posix.relative(this.root, toPosix(fileName));
  }

  abs(relPath: string): string {
    return path.posix.join(this.root, toPosix(relPath));
  }

  /** Original-file location of a node of the probed program. */
  loc(node: TS.Node): SourceLocation {
    const sf = node.getSourceFile();
    const original = this.originals.get(sf.fileName) ?? sf;
    const start = this.facts.toOriginalPosition(sf.fileName, node.getStart(sf));
    const end = this.facts.toOriginalPosition(sf.fileName, node.getEnd());
    const s = original.getLineAndCharacterOfPosition(start);
    const e = original.getLineAndCharacterOfPosition(end);
    return {
      file: this.rel(sf.fileName),
      line: s.line + 1,
      column: s.character + 1,
      endLine: e.line + 1,
      endColumn: e.character + 1,
    };
  }
}
