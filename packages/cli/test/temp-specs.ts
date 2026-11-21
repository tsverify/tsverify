import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import { CANONICAL_SPEC, INVALID_SPEC, REPO_ROOT } from "./run";

/** The canonical spec with `refund` made non-atomic: the B6 double-refund race. */
export async function b6VariantText(): Promise<string> {
  const canonical = await readFile(join(REPO_ROOT, CANONICAL_SPEC), "utf8");
  const refund = canonical.indexOf("\n  refund:\n");
  const atomic = canonical.indexOf("atomic: true", refund);
  if (refund < 0 || atomic < 0) throw new Error("canonical spec changed: no atomic refund");
  return `${canonical.slice(0, atomic)}atomic: false${canonical.slice(atomic + "atomic: true".length)}`;
}

export async function invalidSpecText(): Promise<string> {
  return readFile(join(REPO_ROOT, INVALID_SPEC), "utf8");
}

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp directory holding `files` (relative path → text), removed after the test file. */
export async function tempSpecDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsv-cli-"));
  created.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}
