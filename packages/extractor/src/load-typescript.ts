/**
 * Finds the TypeScript to read a project with. tsverify bundles none: it reads code through
 * TypeScript 7's API (`typescript/sync` and `typescript/ast`, `typescript/unstable/*` in 7.0),
 * which starts the project's own native compiler, so it needs the project's `typescript` 7.0 or
 * later. Older TypeScript has no such API.
 *
 * The API modules are ES modules, loaded synchronously with `require` (Node 22.12+), so the
 * extractor stays synchronous. Nothing here imports `typescript` statically: an install of
 * tsverify must never depend on one.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { TypeScript } from "./typescript";

/** The oldest TypeScript whose API the extractor supports. */
export const MIN_TYPESCRIPT = "7.0";

export interface LoadedTypeScript {
  ts: TypeScript;
  /** The package version, e.g. `7.0.2`. */
  version: string;
  /** Resolved entry file of the synchronous API module. */
  path: string;
}

export interface TypeScriptLoadError {
  error: string;
  /** Version of the project's own `typescript` package, when it has one. */
  projectVersion?: string;
}

/**
 * The project cannot be read as set up: no usable TypeScript, a compiler that does not start, or
 * a tsconfig TypeScript rejects. Thrown by `extractAll`; the CLI reports it as exit code 2.
 */
export class TypeScriptSetupError extends Error {
  override readonly name = "TypeScriptSetupError";
}

/** API entry points, stable (7.1+) first. */
const ENTRY_POINTS = [
  { sync: "sync", ast: "ast" },
  { sync: "unstable/sync", ast: "unstable/ast" },
] as const;

type Rejected = { version: string; reason: "too-old" | "no-api" | "broken"; detail?: string };
type Probe = { loaded: LoadedTypeScript } | { rejected: Rejected };

function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  const [major = 0, minor = 0] = parse(version);
  const [minMajor = 0, minMinor = 0] = parse(min);
  return major !== minMajor ? major > minMajor : minor >= minMinor;
}

function packageVersion(req: NodeJS.Require, name: string): string | undefined {
  try {
    const manifest = req(`${name}/package.json`) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Package `name` as `req` resolves it: undefined when it is not installed. */
function probe(req: NodeJS.Require, name: string): Probe | undefined {
  const version = packageVersion(req, name);
  if (version === undefined) {
    try {
      req.resolve(name);
    } catch {
      return undefined;
    }
    return { rejected: { version: "unknown", reason: "broken", detail: "no package.json" } };
  }
  if (!versionAtLeast(version, MIN_TYPESCRIPT)) return { rejected: { version, reason: "too-old" } };
  for (const entry of ENTRY_POINTS) {
    let syncPath: string;
    let astPath: string;
    try {
      syncPath = req.resolve(`${name}/${entry.sync}`);
      astPath = req.resolve(`${name}/${entry.ast}`);
    } catch {
      continue;
    }
    try {
      const sync = req(syncPath) as TypeScript["sync"];
      const ast = req(astPath) as TypeScript["ast"];
      if (typeof sync.API !== "function" || typeof ast.SyntaxKind !== "object") {
        return { rejected: { version, reason: "broken", detail: `${entry.sync} has no API` } };
      }
      return { loaded: { ts: { version, sync, ast }, version, path: syncPath } };
    } catch (error) {
      return { rejected: { version, reason: "broken", detail: errorText(error) } };
    }
  }
  return { rejected: { version, reason: "no-api" } };
}

const HEADLINE = "tsverify needs TypeScript 7 or later to read your code.";

function loadErrorMessage(project: Rejected | undefined, root: string): string {
  if (project === undefined) {
    return `${HEADLINE} No TypeScript is installed for ${root}: add it with \`npm i -D typescript\`.`;
  }
  const has = `This project has TypeScript ${project.version}`;
  switch (project.reason) {
    case "too-old":
      return `${HEADLINE} ${has}: upgrade it with \`npm i -D typescript@latest\`.`;
    case "no-api":
      return `${HEADLINE} ${has}, which has neither \`typescript/sync\` nor \`typescript/unstable/sync\`: upgrade it with \`npm i -D typescript@latest\`.`;
    case "broken":
      return `${HEADLINE} ${has}, which failed to load (${project.detail}): reinstall it with \`npm i -D typescript\`.`;
  }
}

/**
 * Loads TypeScript 7 or later:
 * 1. `typescript` resolved from `projectRoot` (and the directories above it);
 * 2. only if the project has none, `typescript` resolved from tsverify's own install location
 *    (`selfUrl`), which covers a monorepo whose root has it and tsverify's own development.
 *
 * A project whose own TypeScript is older than 7 gets an error naming its version and the fix,
 * never a different TypeScript found elsewhere.
 */
export function loadTypeScript(
  projectRoot: string,
  selfUrl: string | URL = import.meta.url,
): LoadedTypeScript | TypeScriptLoadError {
  const root = path.resolve(projectRoot);
  const fromProject = probe(createRequire(path.join(root, "package.json")), "typescript");
  const result = fromProject ?? probe(createRequire(selfUrl), "typescript");
  if (result && "loaded" in result) return result.loaded;
  const rejected = fromProject && "rejected" in fromProject ? fromProject.rejected : undefined;
  return {
    error: loadErrorMessage(rejected, root),
    ...(rejected ? { projectVersion: rejected.version } : {}),
  };
}

/**
 * Loads the TypeScript package `name` (e.g. a devDependency alias such as `typescript71`) as
 * resolved from `from`. For tests that run the extractor on a specific TypeScript.
 */
export function loadTypeScriptPackage(
  name: string,
  from: string | URL,
): LoadedTypeScript | TypeScriptLoadError {
  const result = probe(createRequire(from), name);
  if (!result) return { error: `${name} is not installed` };
  if ("loaded" in result) return result.loaded;
  return {
    error: loadErrorMessage(result.rejected, name),
    projectVersion: result.rejected.version,
  };
}
