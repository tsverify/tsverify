import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findProjectRoot, resolveProjectDir } from "./project-root";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsv-project-root-"));
  for (const path of ["outer/tsconfig.json", "outer/inner/tsconfig.json", "outer/inner/src/x"]) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), "{}");
  }
  await mkdir(join(dir, "outer/inner/tsconfig.d/deep"), { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("takes the spec's own directory when it has a tsconfig.json", async () => {
    expect(await findProjectRoot(join(dir, "outer/o.behavior.yaml"))).toBe(join(dir, "outer"));
  });

  it("walks up to the nearest tsconfig.json (the nearest wins over outer ones)", async () => {
    const spec = join(dir, "outer/inner/src/orders/o.behavior.yaml");
    expect(await findProjectRoot(spec)).toBe(join(dir, "outer/inner"));
  });

  it("ignores a directory named like a tsconfig", async () => {
    const spec = join(dir, "outer/inner/tsconfig.d/deep/o.behavior.yaml");
    expect(await findProjectRoot(spec)).toBe(join(dir, "outer/inner"));
  });

  it("returns undefined when no directory up the tree has one", async () => {
    // Assumes nothing above the temp directory holds a tsconfig.json.
    expect(await findProjectRoot(join(dir, "o.behavior.yaml"))).toBeUndefined();
  });
});

describe("resolveProjectDir", () => {
  it("resolves against the cwd", async () => {
    expect(await resolveProjectDir("outer/inner", dir)).toBe(join(dir, "outer/inner"));
    expect(await resolveProjectDir(join(dir, "outer"), "/")).toBe(join(dir, "outer"));
  });

  it("rejects missing directories and files", async () => {
    expect(await resolveProjectDir("nope", dir)).toBeUndefined();
    expect(await resolveProjectDir("outer/tsconfig.json", dir)).toBeUndefined();
  });
});
