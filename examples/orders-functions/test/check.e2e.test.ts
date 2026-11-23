/**
 * End-to-end: `tsverify check` on the storage-functions app, clean and with every seeded-bug
 * variant. B1–B6 must give exactly the findings (ids and severities) the assign app's
 * `tsverify check` gives for the same bug (its goldens in packages/cli/test/e2e/__golden__); B7 is
 * specific to conditional saves. Every variant also meets its `variant.json`. The pretty output
 * of the clean app and of B7 is pinned in `__golden__/`.
 */
import { type Io, main } from "@tsverify/cli";
import { describe, expect, it } from "vitest";
import { listVariants, matchesExpected, materialize, readManifest } from "./materialize";
import { assignCheckFindings, tsverifyCheck } from "./tsverify";

const VARIANTS = await listVariants();
const SHARED = VARIANTS.filter((v) => v !== "b7-unchecked-receipt");

/** `tsverify check src` (pretty, no colors) in the materialized app. */
async function pretty(variant: string | undefined): Promise<string> {
  const app = await materialize(variant);
  try {
    let stdout = "";
    const io: Io = {
      stdout: (s) => {
        stdout += s;
      },
      stderr: () => {},
      cwd: app.root,
      isTTY: false,
      env: {},
    };
    await main(["check", "src"], io);
    return stdout;
  } finally {
    await app.dispose();
  }
}

describe("tsverify check on examples/orders-functions", { timeout: 60_000 }, () => {
  it("passes the clean app with no findings, like the assign app", async () => {
    const run = await tsverifyCheck(undefined);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.report.findings).toEqual([]);
    expect(await assignCheckFindings("clean")).toEqual([]);
    expect(run.report.specs).toEqual([
      expect.objectContaining({
        file: "src/orders/order.behavior.yaml",
        project: ".",
        declaredAtomic: [
          { transition: "checkout", by: "withTransaction" },
          { transition: "refund", by: "withTransaction" },
          { transition: "ship", by: "withTransaction" },
        ],
      }),
    ]);
  });

  it("says which transitions are atomic only as declared", async () => {
    const out = await pretty(undefined);
    expect(out).toContain(
      "checkout, refund, ship: atomic, as declared by `withTransaction` (not checked inside it)",
    );
    await expect(out).toMatchFileSnapshot("__golden__/clean.pretty.txt");
  });

  it.each(VARIANTS)("fails %s with its expected findings", async (variant) => {
    const manifest = await readManifest(variant);
    const run = await tsverifyCheck(variant);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(1);
    for (const expected of manifest.expected) {
      expect(
        run.report.findings.some((f) => matchesExpected(f, expected)),
        `no finding matches ${JSON.stringify(expected)}`,
      ).toBe(true);
    }
  });

  it.each(SHARED)("%s: the same findings as the assign app", async (variant) => {
    const run = await tsverifyCheck(variant);
    expect(run.report.findings.map((f) => `${f.severity} ${f.id}`)).toEqual(
      await assignCheckFindings(variant),
    );
  });

  it("b7: a receipt sent whatever the conditional save returned is not atomic", async () => {
    const run = await tsverifyCheck("b7-unchecked-receipt");
    expect(run.report.findings.map((f) => `${f.severity} ${f.id}`)).toEqual([
      "error non-atomic:Order lifecycle:payment_succeeded",
      "error implementation-property:Order lifecycle:rule:Refund issued at most once per order",
      "error implementation-property:Order lifecycle:rule:Shipped orders are never refunded",
      "error implementation-property:Order lifecycle:effect-multiplicity:email.receipt",
      "error implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
    ]);
    const finding = run.report.findings[0];
    expect(finding?.message).toContain(
      "email.send can run although storage.updateStatusIf found status changed: the call is not behind a check of the save's result",
    );
    await expect(await pretty("b7-unchecked-receipt")).toMatchFileSnapshot(
      "__golden__/b7-unchecked-receipt.pretty.txt",
    );
  });
});
