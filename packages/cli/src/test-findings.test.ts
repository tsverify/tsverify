import type { Finding } from "@tsverify/ir";
import type { GeneratedTest } from "@tsverify/testgen";
import { describe, expect, it } from "vitest";
import { outDirs, specSlug } from "./generated-dir";
import { testFindings } from "./test-findings";
import { describeError, type TestOutcome } from "./test-run";

const OUT = ".tsverify/generated/order-lifecycle";
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

  describe("tests that fail before they run (setup)", () => {
    const forbidden: GeneratedTest = { ...path, file: "forbidden.test.ts", kind: "forbidden" };
    const resolveError =
      'Failed to resolve entry for package "@acme/run-store". The package may have incorrect main/module/exports specified in its package.json.';

    it("reports them once per error, with a setup hint and the original error", () => {
      const { findings, counts } = map(
        [path, forbidden, replay],
        [
          outcome(path, { state: "failed", errors: [resolveError], setup: true }),
          outcome(forbidden, { state: "failed", errors: [resolveError], setup: true }),
          outcome(replay, { state: "failed", errors: [resolveError], setup: true }),
        ],
      );
      expect(counts).toEqual({ total: 3, passed: 0, failed: 3, missing: 0 });
      expect(findings).toEqual([
        {
          id: "generated-test-failed:Order lifecycle:setup:paths.test.ts",
          category: "generated-test-failed",
          severity: "error",
          message: `The generated tests in paths.test.ts, forbidden.test.ts and replay-1.test.ts could not start (3 tests), before any of the code under test ran: ${resolveError}`,
          behavior: "Order lifecycle",
          hint: expect.stringMatching(/^A setup problem, not a behavior the spec forbids\./),
        },
      ]);
      expect(findings[0]?.hint).not.toContain("The real code");
    });

    it("names the cause of a module mock that failed to load, and keeps the stacks", () => {
      const wrapped = describeError({
        name: "Error",
        message:
          '[vitest] There was an error when mocking a module. If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file.',
        stack: "Error: [vitest] There was an error when mocking a module.\n    at src/audit.ts:4:1",
        cause: {
          name: "ConnectionError",
          message: "DATABASE_URL is not set",
          stack: "ConnectionError: DATABASE_URL is not set\n    at connect (src/db.ts:10:9)",
        },
      });
      expect(wrapped).toEqual({
        message:
          "a module the tests mock (vi.mock) failed to load: ConnectionError: DATABASE_URL is not set",
        detail: [
          "Error: [vitest] There was an error when mocking a module.",
          "    at src/audit.ts:4:1",
          "Caused by: ConnectionError: DATABASE_URL is not set",
          "    at connect (src/db.ts:10:9)",
        ].join("\n"),
      });
      const { findings } = map(
        [path, forbidden],
        [
          outcome(path, {
            state: "failed",
            errors: [wrapped.message],
            details: [wrapped.detail],
            setup: true,
          }),
          outcome(forbidden, {
            state: "failed",
            errors: [wrapped.message],
            details: [wrapped.detail],
            setup: true,
          }),
        ],
      );
      expect(findings).toEqual([
        expect.objectContaining({
          message: `The generated tests in paths.test.ts and forbidden.test.ts could not start (2 tests), before any of the code under test ran: ${wrapped.message}`,
          detail: wrapped.detail,
        }),
      ]);
      expect(findings[0]?.hint).toContain("no `setupFiles`, `env` or plugins");
      // Any other error with a cause keeps its message and names the cause.
      expect(
        describeError({ message: "boom", cause: { name: "TypeError", message: "x is undefined" } })
          .message,
      ).toBe("boom (caused by TypeError: x is undefined)");
    });

    it("also knows a setup error by its message", () => {
      const { findings } = map(
        [forbidden],
        [
          outcome(forbidden, {
            state: "failed",
            errors: ["[vitest] There was an error when mocking a module. Cause: TypeError: …"],
          }),
        ],
      );
      expect(findings.map((f) => f.id)).toEqual([
        "generated-test-failed:Order lifecycle:setup:forbidden.test.ts",
      ]);
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
      tsverifyReplay: {
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
      [outcome(replay, { meta: meta("inconclusive", { violated: undefined }) })],
    ).findings;
    expect(inconclusive).toMatchObject({ category: "unanalyzable", severity: "info" });
  });

  it("links a confirmed replay to its static finding only when that finding is known", () => {
    const failed = outcome(replay, {
      state: "failed",
      meta: { tsverifyReplay: { verdict: "confirmed", followed: true, violated: true } },
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
      ".tsverify/generated/order-lifecycle",
      ".tsverify/generated/order-lifecycle-2",
      ".tsverify/generated/stock",
    ]);
  });
});
