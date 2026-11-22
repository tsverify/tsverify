import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GeneratedFile } from "@tsverify/testgen";

/** Where `tsv test` writes, relative to the project root. Users add `.tsv/` to `.gitignore`. */
export const GENERATED_ROOT = ".tsv/generated";

/** `Order lifecycle` → `order-lifecycle`. */
export function specSlug(behavior: string): string {
  const slug = behavior
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "spec" : slug;
}

/**
 * Project-relative output directory per spec: `.tsv/generated/<slug>`, with `-2`, `-3`, … for
 * specs of one project whose behavior names give the same slug (in spec file order).
 */
export function outDirs(behaviors: readonly string[]): string[] {
  const used = new Set<string>();
  return behaviors.map((behavior) => {
    const base = specSlug(behavior);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return `${GENERATED_ROOT}/${slug}`;
  });
}

/** Deletes `<root>/<outDir>` and writes `files` into it. */
export async function writeGenerated(
  root: string,
  outDir: string,
  files: readonly GeneratedFile[],
): Promise<void> {
  const dir = join(root, outDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}
