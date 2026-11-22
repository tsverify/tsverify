import {
  type BehaviorModel,
  type Finding,
  ruleProperty,
  type Trace,
  type Transition,
} from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import { describe, expect, it } from "vitest";
import { check, toItf } from "../src/index";

const REFUND_RULE = ruleProperty("Refund issued at most once per order");
const UNPAID_RULE = ruleProperty("Unpaid orders don't linger");

function transition(model: BehaviorModel, name: string): Transition {
  const t = model.transitions.find((t) => t.name === name);
  if (!t) throw new Error(`no transition ${name}`);
  return t;
}

function byProperty(findings: readonly Finding[], property: string): Finding[] {
  return findings.filter((f) => f.property === property);
}

function errors(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "error");
}

function actions(trace: Trace | undefined): string[] {
  return (trace?.steps ?? []).flatMap((s) =>
    s.action ? [`${s.action.kind}(${s.action.worker})`] : [],
  );
}

function last<T>(xs: readonly T[]): T {
  const x = xs[xs.length - 1];
  if (x === undefined) throw new Error("empty");
  return x;
}

/** Structural invariants every trace must satisfy. */
function expectConsistent(trace: Trace): void {
  expect(trace.steps[0]?.action).toBeUndefined();
  trace.steps.forEach((step, i) => {
    expect(step.index).toBe(i);
    const ids = step.state.workers.map((w) => w.id);
    expect(ids).toEqual(
      [...ids].sort((a, b) => {
        const [ta = "", na = "0"] = a.split("#");
        const [tb = "", nb = "0"] = b.split("#");
        return ta === tb ? Number(na) - Number(nb) : ta < tb ? -1 : 1;
      }),
    );
    if (i === 0) {
      expect(step.state.workers.every((w) => w.phase === "idle")).toBe(true);
      return;
    }
    const prev = trace.steps[i - 1]?.state;
    const action = step.action;
    if (!prev || !action) throw new Error("missing step data");
    // Exactly the acting worker changed, along idle → checked → done or idle → done.
    step.state.workers.forEach((w, j) => {
      const before = prev.workers[j];
      if (w.id !== action.worker) {
        expect(w).toEqual(before);
        return;
      }
      const expected = {
        atomic: ["idle", "done"],
        read: ["idle", "checked"],
        write: ["checked", "done"],
      };
      expect([before?.phase, w.phase]).toEqual(expected[action.kind]);
      expect(action.duplicate === true).toBe(w.duplicate === true);
      if (action.kind === "read") expect(w.observed).toBe(prev.status);
      else expect(w.observed).toBe(before?.observed);
    });
  });
}

describe("canonical Order model", () => {
  it("has no errors and no warnings", () => {
    const { findings, stats } = check(orderModel());
    expect(findings).toEqual([]);
    expect(stats).toMatchObject({ states: 6, edges: 5, complete: true, boundLimitedDeadlocks: 0 });
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("with checkout non-atomic, finds the lost-update race", () => {
    // A stale second checkout write moves a paid order back to pending_payment and re-fires
    // payment and refund.
    const m = orderModel();
    transition(m, "checkout").atomic = false;
    const { findings, stats } = check(m);
    expect(stats).toMatchObject({ states: 38, complete: true });
    expect(findings.map((f) => f.id)).toEqual([
      `spec-property:Order lifecycle:${REFUND_RULE}`,
      `spec-property:Order lifecycle:${ruleProperty("Shipped orders are never refunded")}`,
      "spec-property:Order lifecycle:effect-multiplicity:email.receipt",
      "spec-property:Order lifecycle:effect-multiplicity:stripe.refund",
    ]);
    const [receipt] = byProperty(findings, "effect-multiplicity");
    expect(actions(receipt?.trace)).toEqual([
      "read(checkout#1)",
      "read(checkout#2)",
      "write(checkout#1)",
      "atomic(payment_succeeded#1)",
      "write(checkout#2)",
      "atomic(payment_succeeded#2)",
    ]);
    // The emitter is atomic; the hint names the stale writer instead.
    expect(receipt?.hint).toBe("mark `checkout` atomic: true, or make its state write conditional");
    for (const f of findings) if (f.trace) expectConsistent(f.trace);
  });
});

describe("B6: refund missing atomic: true", () => {
  function b6(): BehaviorModel {
    const m = orderModel();
    transition(m, "refund").atomic = false;
    return m;
  }

  it("reports effect-multiplicity and the at-most-once rule", () => {
    const { findings, stats } = check(b6());
    expect(stats).toMatchObject({ states: 15, complete: true });
    expect(findings.map((f) => f.property)).toEqual([REFUND_RULE, "effect-multiplicity"]);
    const [multiplicity] = byProperty(findings, "effect-multiplicity");
    expect(multiplicity).toMatchObject({
      id: "spec-property:Order lifecycle:effect-multiplicity:stripe.refund",
      category: "spec-property",
      severity: "error",
      behavior: "Order lifecycle",
      transition: "refund",
      hint: "mark `refund` atomic: true, or make its state write conditional",
    });
  });

  it("produces the shortest read, read, write, write counterexample", async () => {
    const { findings } = check(b6());
    const trace = byProperty(findings, REFUND_RULE)[0]?.trace;
    if (!trace) throw new Error("no trace");
    expect(trace.kind).toBe("invariant");
    expect(actions(trace).slice(-4)).toEqual([
      "read(refund#1)",
      "read(refund#2)",
      "write(refund#1)",
      "write(refund#2)",
    ]);
    const end = last(trace.steps).state;
    expect(end.status).toBe("refunded");
    expect(end.effects["stripe.refund"]).toBe(2);
    expectConsistent(trace);
    // effect-multiplicity reaches the same state by the same shortest path.
    expect(byProperty(findings, "effect-multiplicity")[0]?.trace?.steps).toEqual(trace.steps);

    await expect(`${JSON.stringify(trace, null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/b6-refund-race.trace.json",
    );
    await expect(`${JSON.stringify(toItf(trace), null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/b6-refund-race.itf.json",
    );
  });
});

describe("code-origin duplicate webhook (B4 analogue)", () => {
  const RECEIPT_ID = "implementation-property:Order lifecycle:effect-multiplicity:email.receipt";

  it("reports implementation-property effect-multiplicity with a duplicate delivery", () => {
    const m = orderModel();
    m.origin = "code";
    transition(m, "payment_succeeded").from = "*";
    const { findings } = check(m);
    expect(findings.every((f) => f.category === "implementation-property")).toBe(true);
    // A redelivery from `refunded` also re-enables refund, so stripe.refund and the rules fail too.
    const f = findings.find((f) => f.id === RECEIPT_ID);
    expect(f).toMatchObject({ property: "effect-multiplicity", transition: "payment_succeeded" });
    const trace = f?.trace;
    if (!trace) throw new Error("no trace");
    expect(trace.model).toBe("code");
    expect(trace.steps.some((s) => s.action?.duplicate === true)).toBe(true);
    expect(last(trace.steps).state.effects["email.receipt"]).toBe(2);
    expect(f?.hint).toContain("narrow the `from` states of `payment_succeeded`");
    expectConsistent(trace);
  });

  it("points codeAt at the effect call site when the extractor recorded one", () => {
    const m = orderModel();
    m.origin = "code";
    const ps = transition(m, "payment_succeeded");
    ps.from = "*";
    const at = { file: "src/payments/webhook.ts", line: 12, column: 3 };
    ps.sites = {
      persistence: "assign",
      write: { file: "src/payments/webhook.ts", line: 9, column: 5 },
      function: { file: "src/payments/webhook.ts", name: "onPaymentSucceeded", at },
      specTransition: "payment_succeeded",
      fromState: { values: "*", unconstrained: true },
      guards: [],
      effects: [
        {
          effect: "email.receipt",
          at,
          client: "email",
          path: "send",
          gate: "email.send",
          occurrence: 0,
        },
      ],
    };
    expect(check(m).findings.find((f) => f.id === RECEIPT_ID)?.codeAt).toEqual(at);
  });
});

describe("code-origin findings", () => {
  it("point at the code and give code-directed hints", () => {
    const m = orderModel();
    m.origin = "code";
    const refund = transition(m, "refund");
    refund.atomic = false;
    const write = { file: "src/orders/refund.ts", line: 15, column: 3 };
    refund.at = write;
    const f = check(m).findings.find(
      (f) => f.id === "implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
    );
    expect(f?.specAt).toBeUndefined();
    expect(f?.codeAt).toEqual(write);
    expect(f?.hint).toBe(
      "make `refund`'s state check and write atomic in the code (one transaction or a conditional update)",
    );
  });
});

describe("no-stuck-states", () => {
  it("reports a reachable non-terminal state with no way out", () => {
    const m = orderModel();
    m.entity.states.push("on_hold");
    m.transitions.push({
      name: "hold",
      from: ["paid"],
      to: "on_hold",
      by: ["admin"],
      requires: [],
      effects: [],
      atomic: true,
      idempotent: false,
    });
    m.concurrency.hold = 2;
    const { findings } = check(m);
    expect(errors(findings).map((f) => f.property)).toEqual(["no-stuck-states"]);
    const trace = findings[0]?.trace;
    if (!trace) throw new Error("no trace");
    expect(trace.kind).toBe("liveness");
    expect(last(trace.steps).state.status).toBe("on_hold");
    expect(actions(trace)).toEqual([
      "atomic(checkout#1)",
      "atomic(payment_succeeded#1)",
      "atomic(hold#1)",
    ]);
    expectConsistent(trace);
  });
});

describe("reachable", () => {
  it("warns about a declared state that is never reached", () => {
    const m = orderModel();
    m.entity.states.push("archived");
    const { findings } = check(m);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "spec-property:Order lifecycle:reachable:archived",
      severity: "warning",
      property: "reachable",
    });
    expect(findings[0]?.trace).toBeUndefined();
  });

  it("is not checked on code models", () => {
    const m = orderModel();
    m.origin = "code";
    m.entity.states.push("archived");
    expect(check(m).findings).toEqual([]);
  });
});

describe("structural lints", () => {
  it("untrusted-guarded: an unguarded transition by an untrusted actor", () => {
    const m = orderModel();
    const at = { file: "order.behavior.yaml", line: 19, column: 3 };
    Object.assign(transition(m, "checkout"), { requires: [], at });
    const { findings } = check(m);
    expect(findings).toEqual([
      expect.objectContaining({
        id: "spec-property:Order lifecycle:untrusted-guarded:checkout",
        property: "untrusted-guarded",
        severity: "error",
        transition: "checkout",
        specAt: at,
      }),
    ]);
  });

  it("untrusted-guarded: an actor-level guard is enough", () => {
    const m = orderModel();
    transition(m, "checkout").requires = [];
    m.actors.customer?.requires.push({ name: "owner", args: [], raw: "owner" });
    expect(check(m).findings).toEqual([]);
  });

  it("webhook-idempotent: a signed-webhook transition that is not idempotent", () => {
    const m = orderModel();
    transition(m, "payment_succeeded").idempotent = false;
    const { findings } = check(m);
    expect(findings.map((f) => f.id)).toEqual([
      "spec-property:Order lifecycle:webhook-idempotent:payment_succeeded",
    ]);
  });

  it("lints only spec models", () => {
    const m = orderModel();
    m.origin = "code";
    transition(m, "checkout").requires = [];
    transition(m, "payment_succeeded").idempotent = false;
    expect(check(m).findings).toEqual([]);
  });
});

describe("eventually (AG EF)", () => {
  it("reports a genuine deadlock where the expression never holds", () => {
    const m = orderModel();
    // Without expire and payment_succeeded, pending_payment has no way out.
    m.transitions = m.transitions.filter(
      (t) => t.name !== "expire" && t.name !== "payment_succeeded",
    );
    const at = { file: "order.behavior.yaml", line: 62, column: 5 };
    Object.assign(m.rules.find((r) => r.kind === "eventually") ?? {}, { at });
    const { findings } = check(m);
    const [f] = byProperty(findings, UNPAID_RULE);
    expect(f).toMatchObject({ severity: "error", specAt: at });
    expect(f?.trace?.kind).toBe("liveness");
    expect(last(f?.trace?.steps ?? []).state.status).toBe("pending_payment");
    expect(actions(f?.trace)).toEqual(["atomic(checkout#1)"]);
    // The same deadlock is also a stuck state, and the payment path is now unreachable.
    expect(byProperty(findings, "no-stuck-states")).toHaveLength(1);
    expect(byProperty(findings, "reachable").map((f) => f.id)).toEqual(
      ["paid", "shipped", "refunded", "cancelled"].map(
        (s) => `spec-property:Order lifecycle:reachable:${s}`,
      ),
    );
  });

  it("concurrency 1 everywhere: no eventually findings", () => {
    const m = orderModel();
    for (const t of m.transitions) m.concurrency[t.name] = 1;
    const { findings, stats } = check(m);
    expect(findings).toEqual([]);
    expect(stats.complete).toBe(true);
  });

  it("ignores budget-limited deadlocks", () => {
    // Three racing checkouts can re-enter pending_payment after the single payment_succeeded and
    // expire invocations are used up. Another invocation would make progress, so it's the bound,
    // not the design: counted, never reported.
    const m = orderModel();
    transition(m, "checkout").atomic = false;
    m.concurrency = { checkout: 3, expire: 1, payment_succeeded: 1, refund: 2, ship: 2 };
    const { findings, stats } = check(m);
    expect(stats.boundLimitedDeadlocks).toBeGreaterThan(0);
    expect(byProperty(findings, UNPAID_RULE)).toEqual([]);
    expect(byProperty(findings, "no-stuck-states")).toEqual([]);
  });
});

describe("state limit", () => {
  it("stops at maxStates with an unanalyzable warning", () => {
    const m = orderModel();
    transition(m, "checkout").atomic = false; // 38 states, so a limit of 10 is hit
    const { findings, stats } = check(m, { maxStates: 10 });
    expect(stats).toMatchObject({ states: 10, complete: false });
    const limit = findings.filter((f) => f.category === "unanalyzable");
    expect(limit).toEqual([
      expect.objectContaining({
        id: "unanalyzable:Order lifecycle:state-limit",
        severity: "warning",
        behavior: "Order lifecycle",
      }),
    ]);
    // An incomplete search can't prove a state unreachable.
    expect(byProperty(findings, "reachable")).toEqual([]);
  });
});

describe("rule metadata", () => {
  it("carries the rule location and a stable id", () => {
    const m = orderModel();
    transition(m, "refund").atomic = false;
    const at = { file: "order.behavior.yaml", line: 60, column: 5 };
    Object.assign(m.rules[0] ?? {}, { at });
    const [f] = byProperty(check(m).findings, REFUND_RULE);
    expect(f).toMatchObject({
      id: `spec-property:Order lifecycle:${REFUND_RULE}`,
      property: REFUND_RULE,
      specAt: at,
      hint: "mark `refund` atomic: true, or make its state write conditional",
    });
    expect(f?.trace?.property).toBe(REFUND_RULE);
  });
});
