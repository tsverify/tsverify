import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const TSCONFIG = "tsconfig.json";

/**
 * The project root of a behavior file: the nearest directory at or above it that contains a
 * `tsconfig.json` (docs/behavior-format.md, "Paths"). `impl` and binding paths are relative to it.
 * Returns an absolute path, or `undefined` when no directory up to the filesystem root has one.
 */
export async function findProjectRoot(specFile: string): Promise<string | undefined> {
  let dir = dirname(resolve(specFile));
  for (;;) {
    if (await isFile(join(dir, TSCONFIG))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A TypeScript project named on the command line (`--project`): its root, which `impl` and
 * binding paths are relative to, and its tsconfig file when it is not `<root>/tsconfig.json`.
 */
export interface ProjectRef {
  /** Absolute project root. */
  root: string;
  /** The tsconfig file name, relative to `root` (e.g. `tsconfig.src.json`); default `tsconfig.json`. */
  tsconfig?: string;
}

/**
 * Resolves `--project` against `cwd`: a directory is the project root (with its `tsconfig.json`);
 * a file is the tsconfig, and its directory the root. `undefined` when there is no such path.
 */
export async function resolveProject(path: string, cwd: string): Promise<ProjectRef | undefined> {
  const absolute = resolve(cwd, path);
  try {
    const stats = await stat(absolute);
    if (stats.isDirectory()) return { root: absolute };
    const name = basename(absolute);
    return stats.isFile()
      ? { root: dirname(absolute), ...(name === TSCONFIG ? {} : { tsconfig: name }) }
      : undefined;
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
