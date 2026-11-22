/**
 * End-to-end: `tsv test` over the demo app (examples/orders-app), clean and with each seeded-bug
 * variant. `tsv test` runs vitest itself, so it runs here as a subprocess
 * (`node packages/cli/bin/tsv.js test src --format json`, cwd = the materialized app) instead of
 * nesting vitest in vitest. About 2–3 s per run.
 *
 * | Variant | Expected                                                                          |
 * |---------|-----------------------------------------------------------------------------------|
 * | clean   | exit 0, every generated test passes                                               |
 * | B1      | exit 1: replay-confirmed (receipt ×2). The unlinked reopenOrder step is fast-     |
 * |         | forwarded by seeding; the real webhook then sends a second receipt                |
 * | B2      | exit 0: static-only bug (the bypass needs `ctx.internal`, which tests never pass) |
 * | B3      | exit 1: replay-confirmed (Stripe refund ×2)                                       |
 * | B4      | exit 1: replay-confirmed (receipt ×2 on redelivery) + failed forbidden tests      |
 * | B5      | exit 1: generated-test-failed on `expire` (undeclared Stripe call)                |
 * | B6      | exit 0: the spec-model replays give replay-disagrees (the code is safer)          |
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "@tsv/ir";
import { describe, expect, it } from "vitest";
import { materialize } from "../../../../examples/orders-app/test/materialize";
import type { JsonReport } from "../../src/output/json";

const BIN = fileURLToPath(new URL("../../bin/tsv.js", import.meta.url));
const GENERATED = ".tsv/generated/order-lifecycle";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** Generated files left in the app after the run. */
  files: string[];
}

async function tsvTest(variant: string | undefined, format = "json"): Promise<Run> {
  const app = await materialize(variant);
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [BIN, "test", "src", "--format", format],
      { cwd: app.root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined } },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({
        code: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
      }),
    );
    const files = (await readdir(join(app.root, GENERATED))).sort();
    return { ...result, files };
  } finally {
    await app.dispose();
  }
}

function report(run: Run): JsonReport {
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as JsonReport;
}

/** `category id` of every error and warning, in output order. */
function problems(doc: JsonReport): string[] {
  return doc.findings.filter((f) => f.severity !== "info").map((f) => `${f.category} ${f.id}`);
}

function find(doc: JsonReport, id: string): Finding {
  const finding = doc.findings.find((f) => f.id === id);
  expect(finding, `no finding ${id} in ${JSON.stringify(problems(doc))}`).toBeDefined();
  return finding as Finding;
}

describe("tsv test on examples/orders-app", { timeout: 60_000 }, () => {
  it("clean: every generated test passes", async () => {
    const run = await tsvTest(undefined);
    const doc = report(run);
    expect(run.code).toBe(0);
    expect(problems(doc)).toEqual([]);
    expect(doc.specs).toEqual([
      expect.objectContaining({
        file: "src/orders/order.behavior.yaml",
        project: ".",
        generated: { dir: GENERATED, tests: { total: 33, passed: 33, failed: 0, missing: 0 } },
      }),
    ]);
    // Only the info findings about guard tests that cannot be generated (impls without actor).
    expect(doc.findings.map((f) => f.id)).toEqual([
      "unanalyzable:Order lifecycle:testgen:guards:expire",
      "unanalyzable:Order lifecycle:testgen:guards:payment_succeeded",
    ]);
    // The generated files are kept in the project.
    expect(run.files).toEqual(["forbidden.test.ts", "guards.test.ts", "paths.test.ts"]);
  });

  it("clean, pretty: says where static findings come from", async () => {
    const run = await tsvTest(undefined, "pretty");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`project: . · ${GENERATED}: 33 tests, 33 passed`);
    expect(run.stdout).toContain(
      "Generated-test results only: static findings (model checking, conformance) come from `tsv check`.",
    );
    expect(run.stdout).toMatch(/✓ 1 spec, 33 generated tests, 0 errors, 0 warnings\n$/);
  });

  it("B3 refund race: the replay confirms the double Stripe refund", async () => {
    const run = await tsvTest("b3-refund-race");
    const doc = report(run);
    expect(run.code).toBe(1);
    expect(problems(doc)).toEqual([
      "replay-confirmed replay-confirmed:Order lifecycle:rule:Refund issued at most once per order:code-model",
      "replay-confirmed replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model",
    ]);
    const confirmed = find(
      doc,
      "replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model",
    );
    expect(confirmed).toMatchObject({
      severity: "error",
      transition: "refund",
      causedBy: ["implementation-property:Order lifecycle:effect-multiplicity:stripe.refund"],
    });
    expect(confirmed.message).toContain("stripe.refunds.create ×2");
    expect(confirmed.trace?.model).toBe("code");
    expect(run.files).toContain("replay-2.test.ts");
    expect(run.files).toContain("replay-2.json");
  });

  it("B4 webhook redelivery: the replay confirms the second receipt", async () => {
    const run = await tsvTest("b4-webhook-dup");
    const doc = report(run);
    expect(run.code).toBe(1);
    const receipt = find(
      doc,
      "replay-confirmed:Order lifecycle:effect-multiplicity:email.receipt:code-model",
    );
    expect(receipt.message).toContain("email.send ×2");
    // Knock-on effects of the same bug: the other code-model counterexamples replay too, and the
    // webhook overwrites the status from every state the spec forbids.
    expect(problems(doc)).toEqual([
      "generated-test-failed generated-test-failed:Order lifecycle:forbidden:payment_succeeded:draft",
      "generated-test-failed generated-test-failed:Order lifecycle:forbidden:payment_succeeded:paid",
      "generated-test-failed generated-test-failed:Order lifecycle:forbidden:payment_succeeded:shipped",
      "generated-test-failed generated-test-failed:Order lifecycle:forbidden:payment_succeeded:refunded",
      "generated-test-failed generated-test-failed:Order lifecycle:forbidden:payment_succeeded:cancelled",
      "replay-confirmed replay-confirmed:Order lifecycle:rule:Refund issued at most once per order:code-model",
      "replay-confirmed replay-confirmed:Order lifecycle:rule:Shipped orders are never refunded:code-model",
      "replay-confirmed replay-confirmed:Order lifecycle:effect-multiplicity:email.receipt:code-model",
      "replay-confirmed replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model",
    ]);
  });

  it("B5 undeclared effect: the expire path test catches the Stripe call", async () => {
    const run = await tsvTest("b5-undeclared-effect");
    const doc = report(run);
    expect(run.code).toBe(1);
    expect(problems(doc)).toEqual([
      "generated-test-failed generated-test-failed:Order lifecycle:path:expire:pending_payment",
    ]);
    const failed = find(doc, "generated-test-failed:Order lifecycle:path:expire:pending_payment");
    expect(failed).toMatchObject({
      severity: "error",
      transition: "expire",
      codeAt: { file: "src/jobs/expire-orders.ts", line: 14 },
    });
    expect(failed.message).toContain(
      'effect calls expire does not declare: stripe.refunds.create({"charge":"ch_1"})',
    );
  });

  it("B6 spec race: the code is safer than the spec (replay-disagrees, exit 0)", async () => {
    const run = await tsvTest("b6-spec-race");
    const doc = report(run);
    expect(run.code).toBe(0);
    expect(problems(doc)).toEqual([
      "replay-disagrees replay-disagrees:Order lifecycle:rule:Refund issued at most once per order:spec-model",
      "replay-disagrees replay-disagrees:Order lifecycle:effect-multiplicity:stripe.refund:spec-model",
    ]);
    const disagrees = find(
      doc,
      "replay-disagrees:Order lifecycle:effect-multiplicity:stripe.refund:spec-model",
    );
    expect(disagrees.severity).toBe("warning");
    expect(disagrees.message).toContain("the code left the schedule (blocked)");
    expect(disagrees.message).toContain("stripe.refunds.create ×1");
  });

  it("B1 reopen: the fast-forwarded reopen lets the real webhook send a second receipt", async () => {
    const run = await tsvTest("b1-reopen");
    const doc = report(run);
    // The undeclared reopenOrder itself is static (tsv check); the code-model counterexample it
    // enables (pay, reopen, pay again) replays with the reopen seeded, and the real webhook does
    // send the receipt again.
    expect(run.code).toBe(1);
    expect(problems(doc)).toEqual([
      "replay-confirmed replay-confirmed:Order lifecycle:effect-multiplicity:email.receipt:code-model",
    ]);
    expect(
      find(doc, "replay-confirmed:Order lifecycle:effect-multiplicity:email.receipt:code-model")
        .message,
    ).toContain("email.send ×2");
  });

  it("B2 guard bypass: static only, every generated test passes", async () => {
    const run = await tsvTest("b2-guard-bypass");
    const doc = report(run);
    // The bypass needs `ctx.internal: true`, which the invocation shape never sets: the guard
    // tests call refundOrder as a customer and are rejected. `tsv check` reports the bug.
    expect(run.code).toBe(0);
    expect(problems(doc)).toEqual([]);
    expect(doc.specs[0]?.generated?.tests).toEqual({
      total: 33,
      passed: 33,
      failed: 0,
      missing: 0,
    });
  });
});
