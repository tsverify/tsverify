import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

/** Resolves `--project` against `cwd`; `undefined` when the directory doesn't exist. */
export async function resolveProjectDir(dir: string, cwd: string): Promise<string | undefined> {
  const absolute = resolve(cwd, dir);
  try {
    return (await stat(absolute)).isDirectory() ? absolute : undefined;
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
