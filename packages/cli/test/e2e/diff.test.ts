/**
 * End-to-end: `tsverify diff` over the demo app (examples/orders-app) in a temporary git repository.
 * The clean app is committed, then the working tree gets a reviewed spec change: B6's overlay
 * (`refund` no longer atomic) plus a new `cancel` transition. The goldens are what a PR comment
 * (Markdown) and a CI job (JSON) would see.
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type MaterializedApp,
  materialize,
  overlayFiles,
  VARIANTS_ROOT,
} from "../../../../examples/orders-app/test/materialize";
import { type Io, main } from "../../src/main";
import type { JsonDiffReport } from "../../src/output/diff";
import { git, initRepo } from "../git-repo";

const SPEC = "src/orders/order.behavior.yaml";
const VARIANT = "b6-spec-race";

/** A customer may cancel an unpaid order (inserted before `ship`). */
const CANCEL = `  cancel:
    from: pending_payment
    to: cancelled
    by: customer
    requires: [owner]
    atomic: true

`;

let app: MaterializedApp;
let commit: string;

beforeAll(async () => {
  app = await materialize();
  await initRepo(app.root);
  commit = (await git(app.root, "rev-parse", "HEAD")).trim();
  for (const file of await overlayFiles(VARIANT)) {
    await copyFile(join(VARIANTS_ROOT, VARIANT, file), join(app.root, file));
  }
  const spec = await readFile(join(app.root, SPEC), "utf8");
  const ship = spec.indexOf("  ship:\n");
  if (ship < 0) throw new Error("orders-app spec changed: no ship transition");
  await writeFile(join(app.root, SPEC), spec.slice(0, ship) + CANCEL + spec.slice(ship));
});

afterAll(async () => {
  await app?.dispose();
});

async function diff(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = { stdout: "", stderr: "" };
  const io: Io = {
    stdout: (s) => {
      out.stdout += s;
    },
    stderr: (s) => {
      out.stderr += s;
    },
    cwd: app.root,
    isTTY: false,
    env: {},
  };
  const code = await main(["diff", "--base", "HEAD", ...args], io);
  // The commit hash depends on every app file; keep the goldens stable when the app changes.
  const strip = (s: string) => s.replaceAll(commit, "<commit>").replaceAll(app.root, "<root>");
  return { code, stdout: strip(out.stdout), stderr: strip(out.stderr) };
}

describe("tsverify diff on examples/orders-app", { timeout: 60_000 }, () => {
  it("renders the spec change as a PR comment", async () => {
    const r = await diff("src");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("| ~ | `refund` | atomic: `yes` → `no` |");
    expect(r.stdout).toContain('pending_payment ==>|"+ cancel · customer (owner)"| cancelled');
    await expect(r.stdout).toMatchFileSnapshot("__golden__/diff-b6-cancel.md");
  });

  it("emits the behavior diff as JSON", async () => {
    const r = await diff("--format", "json");
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as JsonDiffReport;
    expect(doc.base).toEqual({ ref: "HEAD", commit: "<commit>" });
    expect(doc.specs.map((s) => [s.file, s.diff.kind])).toEqual([[SPEC, "changed"]]);
    expect(doc.specs[0]?.diff.transitions.map((t) => [t.kind, t.name])).toEqual([
      ["added", "cancel"],
      ["changed", "refund"],
    ]);
    await expect(r.stdout).toMatchFileSnapshot("__golden__/diff-b6-cancel.json");
  });

  it("prints a compact terminal view", async () => {
    const r = await diff("--format", "pretty");
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot("__golden__/diff-b6-cancel.pretty.txt");
  });
});
