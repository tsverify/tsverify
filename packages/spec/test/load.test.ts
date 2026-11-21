import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSpecFiles, loadSpec } from "../src/index";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const ORDER = "test/fixtures/valid/order.behavior.yaml";

describe("loadSpec", () => {
  it("reports file and locations relative to root", async () => {
    const { model, findings } = await loadSpec(ORDER, { root: PACKAGE });
    expect(findings).toEqual([]);
    expect(model?.file).toBe(ORDER);
    expect(model?.entity.at?.file).toBe(ORDER);
  });

  it("defaults root to the current directory", async () => {
    const absolute = join(PACKAGE, ORDER);
    const { model } = await loadSpec(absolute);
    expect(model?.file).toBe(relative(process.cwd(), absolute).split(sep).join("/"));
  });

  it("reports an unreadable file as a finding", async () => {
    const { model, findings } = await loadSpec("missing.behavior.yaml", { root: PACKAGE });
    expect(model).toBeUndefined();
    expect(findings).toEqual([
      {
        id: "invalid-spec:missing.behavior.yaml:1:1",
        category: "invalid-spec",
        severity: "error",
        message: 'cannot read behavior file "missing.behavior.yaml" (ENOENT)',
        specAt: { file: "missing.behavior.yaml", line: 1, column: 1 },
      },
    ]);
  });

  it("returns findings with locations for an invalid file", async () => {
    const { findings } = await loadSpec("test/fixtures/invalid/bad-initial.behavior.yaml", {
      root: PACKAGE,
    });
    expect(findings[0]?.specAt).toMatchObject({
      file: "test/fixtures/invalid/bad-initial.behavior.yaml",
      line: 7,
    });
  });
});

describe("findSpecFiles", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsv-spec-"));
    const files = [
      "b.behavior.yaml",
      "a/z.behavior.yaml",
      "a/deep/er/y.behavior.yaml",
      "a/notes.yaml",
      "a/behavior.yaml.bak",
      "node_modules/pkg/x.behavior.yaml",
      ".git/x.behavior.yaml",
      ".tsv/x.behavior.yaml",
      "dist/x.behavior.yaml",
      "sub/dist/x.behavior.yaml",
    ];
    for (const f of files) {
      await mkdir(join(dir, f, ".."), { recursive: true });
      await writeFile(join(dir, f), "");
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds behavior files, skipping tool and dependency directories, sorted", async () => {
    expect(await findSpecFiles(dir)).toEqual([
      "a/deep/er/y.behavior.yaml",
      "a/z.behavior.yaml",
      "b.behavior.yaml",
    ]);
  });

  it("finds the package fixtures", async () => {
    const files = await findSpecFiles(join(PACKAGE, "test/fixtures"));
    expect(files).toContain("valid/order.behavior.yaml");
    expect(files).toContain("invalid/unknown-key.behavior.yaml");
    expect(files).toEqual([...files].sort());
  });
});
