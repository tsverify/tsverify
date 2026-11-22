import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** An npm package with code in an esbuild output. */
export interface BundledPackage {
  name: string;
  version: string;
  /** The package's directory, absolute. */
  dir: string;
}

/** The part of an esbuild metafile read here. */
export interface MetafileInputs {
  outputs: Record<string, { inputs: Record<string, unknown> }>;
}

/** `…/node_modules/<name>` or `…/node_modules/@scope/<name>` of an input path. */
const PACKAGE_DIR = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;

/**
 * The npm packages whose files made it into an esbuild build's outputs (inputs under
 * `node_modules/<name>/`), sorted by name, for third-party notices and dependency checks.
 * @param workingDir the build's `absWorkingDir`, which the metafile's paths are relative to
 */
export async function bundledPackages(
  metafile: MetafileInputs,
  workingDir: string,
): Promise<BundledPackage[]> {
  const dirs = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const match = PACKAGE_DIR.exec(input);
      if (match?.[1]) dirs.add(resolve(workingDir, match[1]));
    }
  }
  const packages: BundledPackage[] = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    packages.push({ name: manifest.name, version: manifest.version, dir });
  }
  return packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
