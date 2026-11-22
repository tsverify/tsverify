/**
 * End-to-end: `tsverify test` on the Prisma app, clean and with each seeded-bug variant, as a
 * subprocess (`node packages/cli/bin/tsverify.js test src --format json`). The generated tests run the
 * real app code against `@tsverify/runtime`'s Prisma fake. Expected results are the assign app's
 * (packages/cli/test/e2e/test-command.test.ts), plus B7:
 *
 * | Variant | Expected                                                                          |
 * |---------|-----------------------------------------------------------------------------------|
 * | clean   | exit 0, all 33 generated tests pass                                               |
 * | B1      | exit 1: replay-confirmed (receipt ×2) after the seeded reopen                     |
 * | B2      | exit 0: static-only bug (the bypass needs `ctx.internal`)                         |
 * | B3      | exit 1: replay-confirmed (Stripe refund ×2)                                       |
 * | B4      | exit 1: replay-confirmed (receipt ×2) + failed forbidden tests                    |
 * | B5      | exit 1: generated-test-failed on `expire` (undeclared Stripe call)                |
 * | B6      | exit 0: replay-disagrees (the conditional updateMany lets only one refund through) |
 * | B7      | exit 1: replay-confirmed (Stripe refund ×2): the fake's default-isolation          |
 * |         | `$transaction` takes no lock, so the read-then-write interleaves                   |
 */
import { describe, expect, it } from "vitest";
import { problems, type Run, tsverifyTest } from "./tsverify";

const GENERATED = ".tsverify/generated/order-lifecycle";
const REFUND_RACE = [
  "replay-confirmed replay-confirmed:Order lifecycle:rule:Refund issued at most once per order:code-model",
  "replay-confirmed replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model",
];

function message(run: Run, id: string): string {
  const finding = run.report.findings.find((f) => f.id === id);
  expect(finding, `no finding ${id} in ${JSON.stringify(problems(run.report))}`).toBeDefined();
  return finding?.message ?? "";
}

describe("tsverify test on examples/orders-prisma", { timeout: 60_000 }, () => {
  it("clean: every generated test passes", async () => {
    const run = await tsverifyTest(undefined);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(problems(run.report)).toEqual([]);
    expect(run.report.specs[0]?.generated).toEqual({
      dir: GENERATED,
      tests: { total: 33, passed: 33, failed: 0, missing: 0 },
    });
  });

  it("B1 reopen: the real webhook sends a second receipt", async () => {
    const run = await tsverifyTest("b1-reopen");
    expect(run.code).toBe(1);
    expect(problems(run.report)).toEqual([
      "replay-confirmed replay-confirmed:Order lifecycle:effect-multiplicity:email.receipt:code-model",
    ]);
    expect(
      message(run, "replay-confirmed:Order lifecycle:effect-multiplicity:email.receipt:code-model"),
    ).toContain("email.send ×2");
  });

  it("B2 guard bypass: static only, every generated test passes", async () => {
    const run = await tsverifyTest("b2-guard-bypass");
    expect(run.code).toBe(0);
    expect(problems(run.report)).toEqual([]);
    expect(run.report.specs[0]?.generated?.tests).toMatchObject({ total: 33, passed: 33 });
  });

  it("B3 refund race: the replay confirms the double Stripe refund", async () => {
    const run = await tsverifyTest("b3-refund-race");
    expect(run.code).toBe(1);
    expect(problems(run.report)).toEqual(REFUND_RACE);
    expect(
      message(run, "replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model"),
    ).toContain("stripe.refunds.create ×2");
  });

  it("B4 webhook redelivery: the second receipt, and the forbidden from-states", async () => {
    const run = await tsverifyTest("b4-webhook-dup");
    expect(run.code).toBe(1);
    expect(problems(run.report)).toEqual([
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
    const run = await tsverifyTest("b5-undeclared-effect");
    expect(run.code).toBe(1);
    expect(problems(run.report)).toEqual([
      "generated-test-failed generated-test-failed:Order lifecycle:path:expire:pending_payment",
    ]);
    expect(
      message(run, "generated-test-failed:Order lifecycle:path:expire:pending_payment"),
    ).toContain('effect calls expire does not declare: stripe.refunds.create({"charge":"ch_1"})');
  });

  it("B6 spec race: the code is safer than the spec (replay-disagrees, exit 0)", async () => {
    const run = await tsverifyTest("b6-spec-race");
    expect(run.code).toBe(0);
    expect(problems(run.report)).toEqual([
      "replay-disagrees replay-disagrees:Order lifecycle:rule:Refund issued at most once per order:spec-model",
      "replay-disagrees replay-disagrees:Order lifecycle:effect-multiplicity:stripe.refund:spec-model",
    ]);
    expect(
      message(run, "replay-disagrees:Order lifecycle:effect-multiplicity:stripe.refund:spec-model"),
    ).toContain("stripe.refunds.create ×1");
  });

  it("B7 default-isolation $transaction: the replay confirms the double refund", async () => {
    const run = await tsverifyTest("b7-tx-read-committed");
    expect(run.code).toBe(1);
    expect(problems(run.report)).toEqual(REFUND_RACE);
    expect(
      message(run, "replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model"),
    ).toContain("stripe.refunds.create ×2");
  });
});
