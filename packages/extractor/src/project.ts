/**
 * Loads the TypeScript project once (no emit) and gives the analysis modules a context: the
 * probed program, its checker, and original-file source locations.
 *
 * Order matters (X1): `loadProject` → syntactic write discovery over `files` → `planNarrowing`
 * → only then `ProjectContext` (the first type query happens in its constructor).
 *
 * Uses the TypeScript installed by `useTypeScript` (`typescript.ts`).
 */
import path from "node:path";
import type { SourceLocation } from "@tsverify/ir";
import type * as TS from "@typescript/typescript6";
import { createOverlayHost, type OverlayHost, ProgramTypeFacts } from "./type-facts";
import { ts } from "./typescript";

export interface LoadedProject {
  /** Absolute project root, `/`-separated, no trailing slash. */
  root: string;
  /**
   * Original (unprobed) source files under analysis, sorted by path: the tsconfig's files and
   * every file they import, minus declarations and `node_modules`.
   */
  files: TS.SourceFile[];
  facts: ProgramTypeFacts;
}

export interface LoadError {
  error: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Source files the extractor analyzes: project files that are neither declarations nor deps. */
function isAnalyzed(sf: TS.SourceFile): boolean {
  return !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/");
}

export function loadProject(projectRoot: string, tsconfig?: string): LoadedProject | LoadError {
  const root = toPosix(path.resolve(projectRoot)).replace(/\/$/, "");
  const configPath = toPosix(
    tsconfig === undefined ? path.join(root, "tsconfig.json") : path.resolve(root, tsconfig),
  );
  if (!ts.sys.fileExists(configPath)) {
    return {
      error:
        tsconfig === undefined
          ? `no tsconfig.json in the project directory ${root}`
          : `no tsconfig at ${configPath}`,
    };
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    const why = ts.flattenDiagnosticMessageText(read.error.messageText, "\n");
    return { error: `cannot load ${configPath}: ${why}` };
  }
  let program: TS.Program;
  let host: OverlayHost;
  try {
    const config = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      path.posix.dirname(configPath),
      undefined,
      configPath,
    );
    host = createOverlayHost(config.options);
    // Project references are not passed on: imports of a referenced project resolve to its
    // sources, which the extractor can read, rather than to its built declarations.
    program = ts.createProgram({
      rootNames: config.fileNames,
      options: config.options,
      host,
      configFileParsingDiagnostics: config.errors,
    });
  } catch (error) {
    return { error: `cannot load ${configPath}: ${(error as Error).message}` };
  }
  const files = program
    .getSourceFiles()
    .filter(isAnalyzed)
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return { root, files, facts: new ProgramTypeFacts(program, host) };
}

/** Analysis context over the probed program. Constructing it performs the first type query. */
export class ProjectContext {
  readonly checker: TS.TypeChecker;
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
