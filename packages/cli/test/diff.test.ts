import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonDiffReport } from "../src/output/diff";
import { git, initRepo, writeFiles } from "./git-repo";
import { CANONICAL_SPEC, REPO_ROOT, tsv } from "./run";
import { b6VariantText, invalidSpecText, tempSpecDir } from "./temp-specs";

const canonical = await readFile(join(REPO_ROOT, CANONICAL_SPEC), "utf8");
const named = (name: string, text = canonical) =>
  text.replace("behavior: Order lifecycle\n", `behavior: ${name}\n`);
const enforced = (text: string) => text.replace(/^behavior: .*\n/m, "$&enforced: true\n");

/** A repository with `files` committed on `main`, then `edits` applied to the working tree. */
async function repo(
  files: Record<string, string>,
  edits: Record<string, string | null> = {},
): Promise<string> {
  const dir = await tempSpecDir(files);
  await initRepo(dir);
  await writeFiles(dir, edits);
  return dir;
}

function parse(stdout: string): JsonDiffReport {
  return JSON.parse(stdout) as JsonDiffReport;
}

describe("tsv diff", () => {
  it("pairs specs by path: changed, added, removed and unchanged", async () => {
    const cwd = await repo(
      {
        "specs/order.behavior.yaml": canonical,
        "specs/gone.behavior.yaml": named("Gone"),
        "specs/same.behavior.yaml": named("Same"),
      },
      {
        "specs/order.behavior.yaml": await b6VariantText(),
        "specs/gone.behavior.yaml": null,
        "specs/new.behavior.yaml": named("New"),
      },
    );
    const r = await tsv(["diff", "--base", "main", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const doc = parse(r.stdout);
    expect(doc.base).toEqual({ ref: "main", commit: (await git(cwd, "rev-parse", "main")).trim() });
    expect(doc.specs.map((s) => [s.file, s.diff.kind])).toEqual([
      ["specs/gone.behavior.yaml", "removed"],
      ["specs/new.behavior.yaml", "added"],
      ["specs/order.behavior.yaml", "changed"],
      ["specs/same.behavior.yaml", "unchanged"],
    ]);
    expect(doc.summary).toEqual({ files: 4, added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(doc.specs[2]?.diff.transitions).toEqual([
      { kind: "changed", name: "refund", fields: [{ field: "atomic", base: "yes", head: "" }] },
    ]);
  });

  it("defaults to Markdown and exits 0 when nothing changed", async () => {
    const cwd = await repo({ "order.behavior.yaml": canonical });
    const r = await tsv(["diff", "--base", "HEAD"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "<!-- tsv-diff -->\n## Behavior diff\n\n`HEAD` → working tree: no behavior changes (1 behavior file compared).\n",
    );
  });

  it("pretty: a compact terminal view", async () => {
    const cwd = await repo(
      { "order.behavior.yaml": canonical },
      { "order.behavior.yaml": await b6VariantText() },
    );
    const r = await tsv(["diff", "--base", "HEAD", "--format", "pretty"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        "order.behavior.yaml  Order lifecycle  changed",
        "  ~1 transition",
        "  ~ transition refund  atomic: yes → no",
        "",
        "1 of 1 behavior file changed (HEAD → working tree)",
        "",
      ].join("\n"),
    );
  });

  it("runs from a subdirectory with paths relative to it", async () => {
    const dir = await repo(
      { "app/specs/order.behavior.yaml": canonical, "other/x.behavior.yaml": named("X") },
      { "app/specs/order.behavior.yaml": await b6VariantText() },
    );
    const cwd = join(dir, "app");
    const r = await tsv(["diff", "--base", "HEAD", "specs", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    expect(parse(r.stdout).specs.map((s) => s.file)).toEqual(["specs/order.behavior.yaml"]);
  });

  it("finds specs that exist only in the base, even in a deleted directory", async () => {
    const cwd = await repo({ "old/a.behavior.yaml": canonical }, { "old/a.behavior.yaml": null });
    const r = await tsv(["diff", "--base", "HEAD", "old", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    expect(parse(r.stdout).specs.map((s) => [s.file, s.diff.kind])).toEqual([
      ["old/a.behavior.yaml", "removed"],
    ]);
  });

  it("--enforced-only keeps specs enforced on either side", async () => {
    const cwd = await repo(
      {
        "a.behavior.yaml": enforced(named("A")),
        "b.behavior.yaml": named("B"),
        "c.behavior.yaml": named("C"),
      },
      { "a.behavior.yaml": named("A"), "b.behavior.yaml": enforced(named("B")) },
    );
    const r = await tsv(["diff", "--base", "HEAD", "--enforced-only", "--format", "json"], {
      cwd,
    });
    expect(r.code).toBe(0);
    const doc = parse(r.stdout);
    expect(doc.specs.map((s) => [s.file, s.enforced])).toEqual([
      ["a.behavior.yaml", true],
      ["b.behavior.yaml", true],
    ]);
    expect(doc.specs[0]?.diff.entity).toEqual([{ field: "enforced", base: "yes", head: "" }]);
    const md = await tsv(["diff", "--base", "HEAD", "--enforced-only"], { cwd });
    expect(md.stdout).toContain("\n\n--enforced-only: skipped 1 spec without `enforced: true`.\n");
  });

  it("--enforced-only with no enforced spec is an empty diff that says why", async () => {
    const cwd = await repo({ "a.behavior.yaml": canonical });
    const r = await tsv(["diff", "--base", "HEAD", "--enforced-only", "--format", "pretty"], {
      cwd,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "No enforced specs: --enforced-only keeps only specs with `enforced: true` on either side, and none of the 1 spec found has it.\n0 of 0 behavior files changed (HEAD → working tree)\n",
    );
  });

  describe("invalid input (exit 2)", () => {
    it("requires --base", async () => {
      const cwd = await repo({ "a.behavior.yaml": canonical });
      const r = await tsv(["diff"], { cwd });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^error: --base <git-ref> is required/);
    });

    it("rejects an unknown --format", async () => {
      const cwd = await repo({ "a.behavior.yaml": canonical });
      const r = await tsv(["diff", "--base", "HEAD", "--format", "sarif"], { cwd });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^error: --format must be one of markdown, json, pretty/);
    });

    it("reports an unknown ref", async () => {
      const cwd = await repo({ "a.behavior.yaml": canonical });
      const r = await tsv(["diff", "--base", "nope/main"], { cwd });
      expect(r).toEqual({
        code: 2,
        stdout: "",
        stderr: 'error: unknown git ref "nope/main" (no such branch, tag or commit)\n',
      });
    });

    it("reports a cwd outside any git repository", async () => {
      const cwd = await tempSpecDir({ "a.behavior.yaml": canonical });
      const r = await tsv(["diff", "--base", "HEAD"], { cwd });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^error: not in a git repository: /);
    });

    it("reports an invalid base spec, located at the ref", async () => {
      const cwd = await repo(
        { "a.behavior.yaml": await invalidSpecText() },
        { "a.behavior.yaml": canonical },
      );
      const r = await tsv(["diff", "--base", "HEAD"], { cwd });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("HEAD:a.behavior.yaml:18:9");
    });

    it("reports an invalid working-tree spec", async () => {
      const cwd = await repo(
        { "a.behavior.yaml": canonical },
        { "a.behavior.yaml": await invalidSpecText() },
      );
      const r = await tsv(["diff", "--base", "HEAD", "--format", "json"], { cwd });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(" a.behavior.yaml:18:9");
    });

    it("reports paths with no specs on either side", async () => {
      const cwd = await repo({ "a.behavior.yaml": canonical });
      await mkdir(join(cwd, "empty"));
      const r = await tsv(["diff", "--base", "HEAD", "empty"], { cwd });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(
        /^error: no \*\.behavior\.yaml files in empty \(working tree or HEAD\)/,
      );
    });
  });
});
