/**
 * Finds the TypeScript to read a project with. tsverify bundles none: it needs the classic
 * JavaScript compiler API (`createProgram`, TypeScript 5.4–6.x), which TypeScript 7 dropped, so it
 * takes the project's own `typescript` when that has the API and `@typescript/typescript6` (what
 * TS-7 projects add) otherwise.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { TypeScript } from "./typescript";

/** The oldest TypeScript whose compiler API the extractor supports. */
export const MIN_TYPESCRIPT = "5.4";

export interface LoadedTypeScript {
  ts: TypeScript;
  /** `ts.version`, e.g. `6.0.2`. */
  version: string;
  /** Resolved entry file of the module. */
  path: string;
}

export interface TypeScriptLoadError {
  error: string;
  /** Version of the project's own `typescript` package, when it has one. */
  projectVersion?: string;
}

/** Packages that can provide the classic compiler API, in resolution order. */
const CANDIDATES = ["typescript", "@typescript/typescript6"] as const;

interface Probe {
  /** The package resolved but is unusable: its version, and why. */
  rejected?: { version: string; reason: "no-api" | "too-old" | "broken"; detail?: string };
  loaded?: LoadedTypeScript;
}

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

/** `name` as `req` resolves it: undefined when it is not installed. */
function probe(req: NodeJS.Require, name: string): Probe | undefined {
  let entry: string;
  try {
    entry = req.resolve(name);
  } catch {
    return undefined;
  }
  let module: Partial<TypeScript>;
  try {
    module = req(entry) as Partial<TypeScript>;
  } catch (error) {
    const version = packageVersion(req, name) ?? "unknown";
    return { rejected: { version, reason: "broken", detail: (error as Error).message } };
  }
  const version =
    (typeof module.version === "string" ? module.version : undefined) ??
    packageVersion(req, name) ??
    "unknown";
  if (typeof module.createProgram !== "function") {
    return { rejected: { version, reason: "no-api" } };
  }
  if (!versionAtLeast(version, MIN_TYPESCRIPT)) return { rejected: { version, reason: "too-old" } };
  return { loaded: { ts: module as TypeScript, version, path: entry } };
}

const HEADLINE = "tsverify needs the TypeScript compiler API to read your code.";
const ADD_TS6 =
  "add `@typescript/typescript6` as a devDependency (`npm i -D @typescript/typescript6`)";
const OTHERS_FINE = `TypeScript ${MIN_TYPESCRIPT}–6.x projects need nothing extra.`;

function loadErrorMessage(project: Probe["rejected"], root: string): string {
  if (project === undefined) {
    return `${HEADLINE} No TypeScript is installed for ${root}: ${ADD_TS6}, or \`typescript\` ${MIN_TYPESCRIPT}–6.x.`;
  }
  const has = `This project has TypeScript ${project.version}`;
  switch (project.reason) {
    case "no-api":
      return `${HEADLINE} ${has}, which no longer includes it: ${ADD_TS6}. ${OTHERS_FINE}`;
    case "too-old":
      return `${HEADLINE} ${has}, and tsverify supports ${MIN_TYPESCRIPT} or later: upgrade it, or ${ADD_TS6}.`;
    case "broken":
      return `${HEADLINE} ${has}, which failed to load (${project.detail}): reinstall it, or ${ADD_TS6}.`;
  }
}

/**
 * Loads a TypeScript with the classic compiler API (5.4 or later), trying in order:
 * 1. `typescript` resolved from `projectRoot`, if it has `createProgram` (TS 5.4–6.x);
 * 2. `@typescript/typescript6` resolved from `projectRoot` (TS-7 projects);
 * 3. the same two resolved from tsverify's own install location (`selfUrl`), which covers a
 *    monorepo whose root has them and tsverify's own development.
 *
 * Returns an error naming the project's TypeScript version when none is usable.
 */
export function loadTypeScript(
  projectRoot: string,
  selfUrl: string | URL = import.meta.url,
): LoadedTypeScript | TypeScriptLoadError {
  const fromProject = createRequire(path.join(path.resolve(projectRoot), "package.json"));
  const fromSelf = createRequire(selfUrl);
  let projectTs: Probe["rejected"];
  for (const [req, isProject] of [
    [fromProject, true],
    [fromSelf, false],
  ] as const) {
    for (const name of CANDIDATES) {
      const result = probe(req, name);
      if (result?.loaded) return result.loaded;
      if (isProject && name === "typescript") projectTs = result?.rejected;
    }
  }
  return {
    error: loadErrorMessage(projectTs, path.resolve(projectRoot)),
    ...(projectTs ? { projectVersion: projectTs.version } : {}),
  };
}
