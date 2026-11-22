import type { Finding } from "@tsv/ir";
import type { GeneratedTest } from "@tsv/testgen";
import { describe, expect, it } from "vitest";
import { outDirs, specSlug } from "./generated-dir";
import { testFindings } from "./test-findings";
import type { TestOutcome } from "./test-run";

const OUT = ".tsv/generated/order-lifecycle";
const write = { file: "src/jobs/expire-orders.ts", line: 13, column: 5 };
const path: GeneratedTest = {
  file: "paths.test.ts",
  name: "expire: pending_payment → cancelled (no actor argument)",
  kind: "path",
  transition: "expire",
  from: "pending_payment",
  codeAt: write,
};
const replay: GeneratedTest = {
  file: "replay-1.test.ts",
  name: "replay: effect-multiplicity stripe.refund (refund#1 ∥ refund#2)",
  kind: "replay",
  finding: "implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
  property: "effect-multiplicity",
  transition: "refund",
  model: "code",
  evaluable: true,
};
const source: Finding = {
  id: "implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
  category: "implementation-property",
  severity: "error",
  message: "Exactly-once effect `stripe.refund` fires 2 times for one Order.",
};

function outcome(test: GeneratedTest, patch: Partial<TestOutcome>): TestOutcome {
  return {
    file: `${OUT}/${test.file}`,
    name: test.name,
    state: "passed",
    errors: [],
    meta: {},
    ...patch,
  };
}

function map(tests: GeneratedTest[], outcomes: TestOutcome[]) {
  return testFindings({
    behavior: "Order lifecycle",
    outDir: OUT,
    tests,
    outcomes,
    sources: new Map([[source.id, source]]),
  });
}

describe("testFindings", () => {
  it("reports nothing for passing path tests", () => {
    expect(map([path], [outcome(path, {})])).toEqual({
      findings: [],
      counts: { total: 1, passed: 1, failed: 0, missing: 0 },
    });
  });

  it("maps a failed path test to generated-test-failed at the write", () => {
    const { findings, counts } = map(
      [path],
      [outcome(path, { state: "failed", errors: ["effect calls expire does not declare: …"] })],
    );
    expect(counts.failed).toBe(1);
    expect(findings).toEqual([
      expect.objectContaining({
        id: "generated-test-failed:Order lifecycle:path:expire:pending_payment",
        category: "generated-test-failed",
        severity: "error",
        transition: "expire",
        codeAt: write,
        message:
          'Generated path test "expire: pending_payment → cancelled (no actor argument)" failed: effect calls expire does not declare: …',
      }),
    ]);
  });

  it("maps replay verdicts", () => {
    const meta = (verdict: string, extra: object = {}) => ({
      tsvReplay: {
        verdict,
        followed: verdict === "confirmed",
        violated: verdict !== "replay-disagrees",
        status: "refunded",
        effects: { "stripe.refunds.create": verdict === "replay-disagrees" ? 1 : 2 },
        ...extra,
      },
    });
    const divergence = {
      kind: "blocked",
      stepIndex: 1,
      worker: "refund#2",
      message: "Replay diverged…",
    };
    const [confirmed] = map(
      [replay],
      [outcome(replay, { state: "failed", meta: meta("confirmed") })],
    ).findings;
    expect(confirmed).toMatchObject({
      id: "replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model",
      category: "replay-confirmed",
      severity: "error",
      message:
        "Replay confirmed in the real code: Exactly-once effect `stripe.refund` fires 2 times for one Order. Observed: final state refunded; stripe.refunds.create ×2.",
      causedBy: [source.id],
    });
    const [divergent] = map(
      [replay],
      [outcome(replay, { state: "failed", meta: meta("confirmed-divergent", { divergence }) })],
    ).findings;
    expect(divergent).toMatchObject({ category: "replay-confirmed", severity: "error" });
    expect(divergent?.message).toContain(
      "Note: the code left the counterexample's schedule (blocked)",
    );
    const [disagrees] = map(
      [replay],
      [outcome(replay, { meta: meta("replay-disagrees", { divergence }) })],
    ).findings;
    expect(disagrees).toMatchObject({ category: "replay-disagrees", severity: "warning" });
    expect(disagrees?.causedBy).toBeUndefined();
    const [inconclusive] = map(
      [replay],
      [outcome(replay, { meta: meta("replay-disagrees", { inconclusive: true }) })],
    ).findings;
    expect(inconclusive).toMatchObject({ category: "unanalyzable", severity: "info" });
  });

  it("links a confirmed replay to its static finding only when that finding is known", () => {
    const failed = outcome(replay, {
      state: "failed",
      meta: { tsvReplay: { verdict: "confirmed", followed: true, violated: true } },
    });
    const unknown = testFindings({
      behavior: "Order lifecycle",
      outDir: OUT,
      tests: [replay],
      outcomes: [failed],
      sources: new Map(),
    });
    expect(unknown.findings[0]).toMatchObject({ category: "replay-confirmed" });
    expect(unknown.findings[0]?.causedBy).toBeUndefined();
  });

  it("reports a replay that failed before recording a verdict", () => {
    const { findings } = map(
      [replay],
      [outcome(replay, { state: "failed", errors: ["trace has nothing to replay"] })],
    );
    expect(findings).toEqual([
      expect.objectContaining({
        category: "generated-test-failed",
        severity: "error",
        message: `The replay test "${replay.name}" could not run: trace has nothing to replay`,
      }),
    ]);
  });

  it("attributes a file's collection error to each of its tests", () => {
    const { findings, counts } = map(
      [path],
      [
        {
          file: `${OUT}/paths.test.ts`,
          name: "",
          state: "failed",
          errors: ["SyntaxError"],
          meta: {},
        },
      ],
    );
    expect(counts.failed).toBe(1);
    expect(findings[0]?.message).toContain("SyntaxError");
  });
});

describe("generated directories", () => {
  it("are named after the behavior", () => {
    expect(specSlug("Order lifecycle")).toBe("order-lifecycle");
    expect(specSlug("Zahlung: Rückerstattung")).toBe("zahlung-ruckerstattung");
    expect(specSlug("!!!")).toBe("spec");
    expect(outDirs(["Order lifecycle", "order-lifecycle", "Stock"])).toEqual([
      ".tsv/generated/order-lifecycle",
      ".tsv/generated/order-lifecycle-2",
      ".tsv/generated/stock",
    ]);
  });
});
