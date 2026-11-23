import { check } from "@tsverify/checker";
import type { BehaviorModel, CodeSites, Finding, FindingCategory, Transition } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import { describe, expect, it } from "vitest";
import { linkRootCauses } from "./root-causes";

const BEHAVIOR = "Order lifecycle";

function transition(model: BehaviorModel, name: string): Transition {
  const t = model.transitions.find((t) => t.name === name);
  if (!t) throw new Error(`no transition ${name}`);
  return t;
}

/** The canonical Order model as extracted from code, after `patch`. */
function codeModel(patch: (m: BehaviorModel) => void): BehaviorModel {
  const m = orderModel();
  m.origin = "code";
  patch(m);
  return m;
}

function at(line: number) {
  return { file: "src/payments/webhook.ts", line, column: 5 };
}

function mismatch(category: FindingCategory, transition: string): Finding {
  return {
    id: `${category}:${BEHAVIOR}:${transition}`,
    category,
    severity: "error",
    message: `${category} on ${transition}`,
    behavior: BEHAVIOR,
    transition,
  };
}

/** Conformance findings followed by the code model's checker findings, as `checkCode` has them. */
function link(code: BehaviorModel, mismatches: Finding[]): Finding[] {
  return linkRootCauses([...mismatches, ...check(code).findings], orderModel());
}

function causes(findings: readonly Finding[]): Record<string, string[] | undefined> {
  return Object.fromEntries(
    findings.filter((f) => f.trace !== undefined).map((f) => [f.property, f.causedBy]),
  );
}

describe("linkRootCauses", () => {
  // B3: refund reads and writes outside one atomic scope.
  const b3 = () => codeModel((m) => (transition(m, "refund").atomic = false));

  it("links a stale write outside `from` to non-atomic (B3)", () => {
    const nonAtomic = mismatch("non-atomic", "refund");
    const linked = link(b3(), [nonAtomic]);
    expect(causes(linked)).toEqual({
      "effect-multiplicity": [nonAtomic.id],
      "rule:Refund issued at most once per order": [nonAtomic.id],
    });
    // The cause itself is left alone.
    expect(linked[0]).toBe(nonAtomic);
  });

  it("does not link non-atomic on a transition that writes no stale status", () => {
    const linked = link(b3(), [mismatch("non-atomic", "checkout")]);
    expect(linked.every((f) => f.causedBy === undefined)).toBe(true);
  });

  it("does not link non-atomic when the spec allows the status written over", () => {
    // With refund allowed from refunded too, the stale write is one the spec permits.
    const spec = orderModel();
    transition(spec, "refund").from = ["paid", "refunded"];
    const findings = [mismatch("non-atomic", "refund"), ...check(b3()).findings];
    expect(linkRootCauses(findings, spec).every((f) => f.causedBy === undefined)).toBe(true);
  });

  // B4: the webhook handler marks the order paid from any state.
  const b4 = () => codeModel((m) => (transition(m, "payment_succeeded").from = "*"));

  it("links an action from a status outside `from` to from-state-unconstrained (B4)", () => {
    const unconstrained = mismatch("from-state-unconstrained", "payment_succeeded");
    const linked = link(b4(), [unconstrained]);
    const traced = linked.filter((f) => f.trace !== undefined);
    expect(traced.length).toBeGreaterThan(1);
    for (const f of traced) expect(f.causedBy).toEqual([unconstrained.id]);
  });

  it("links from-state-mismatch the same way, and keeps every cause in finding order", () => {
    const linked = link(b4(), [
      mismatch("from-state-mismatch", "payment_succeeded"),
      mismatch("undeclared-transition", "payment_succeeded"),
    ]);
    const receipt = linked.find((f) => f.id.endsWith("effect-multiplicity:email.receipt"));
    expect(receipt?.causedBy).toEqual([
      `from-state-mismatch:${BEHAVIOR}:payment_succeeded`,
      `undeclared-transition:${BEHAVIOR}:payment_succeeded`,
    ]);
  });

  it("does not link a from-state finding whose transition only acts inside `from`", () => {
    const linked = link(b4(), [mismatch("from-state-unconstrained", "refund")]);
    expect(linked.every((f) => f.causedBy === undefined)).toBe(true);
  });

  it("links any action of an unlinked code transition to undeclared-transition (B1)", () => {
    const code = codeModel((m) => {
      m.transitions.push({
        ...transition(m, "checkout"),
        name: "reopenOrder",
        from: ["paid"],
        to: "pending_payment",
      });
      m.concurrency.reopenOrder = 1;
    });
    const undeclared = mismatch("undeclared-transition", "reopenOrder");
    const linked = link(code, [undeclared, mismatch("guard-not-dominating", "reopenOrder")]);
    const traced = linked.filter((f) => f.trace !== undefined);
    expect(traced.length).toBeGreaterThan(0);
    for (const f of traced) expect(f.causedBy).toEqual([undeclared.id]);
  });

  it("links `t` also writing another state only to steps of that write, not of `t` itself", () => {
    // b4's counterexamples take steps of payment_succeeded (its write of paid): the code's
    // other write (`payment_succeeded->cancelled`) is not in them.
    const alsoWrites: Finding = {
      ...mismatch("undeclared-transition", "payment_succeeded"),
      id: `undeclared-transition:${BEHAVIOR}:payment_succeeded:payment_succeeded->cancelled`,
    };
    const linked = link(b4(), [alsoWrites]);
    expect(linked.filter((f) => f.trace !== undefined).length).toBeGreaterThan(0);
    expect(linked.every((f) => f.causedBy === undefined)).toBe(true);
  });

  it("links a from-state finding only to steps of the write it is about", () => {
    // Two writes of paid: the unconstrained one is `payment_succeeded~2`, at line 30.
    const code = codeModel((m) => {
      const paid = transition(m, "payment_succeeded");
      paid.sites = { specTransition: "payment_succeeded", write: at(10) } as CodeSites;
      m.transitions.push({
        ...structuredClone(paid),
        name: "payment_succeeded~2",
        from: "*",
        sites: { specTransition: "payment_succeeded", write: at(30) } as CodeSites,
      });
      m.concurrency["payment_succeeded~2"] = 2;
    });
    const atSite = (line: number): Finding => ({
      ...mismatch("from-state-unconstrained", "payment_succeeded"),
      id: `from-state-unconstrained:${BEHAVIOR}:payment_succeeded:${line}`,
      codeAt: at(line),
    });
    const findings = [atSite(30), atSite(10), ...check(code).findings];
    const linked = linkRootCauses(findings, orderModel(), code).filter((f) => f.trace);
    expect(linked.length).toBeGreaterThan(0);
    for (const f of linked) expect(f.causedBy).toEqual([atSite(30).id]);
  });

  it("never links a stricter from-state warning through a step", () => {
    const stricter = {
      ...mismatch("from-state-mismatch", "payment_succeeded"),
      severity: "warning",
    };
    const linked = link(b4(), [stricter as Finding]);
    expect(linked.every((f) => f.causedBy === undefined)).toBe(true);
  });

  describe("effect mismatches: only rules that count the effect, in the direction it moves", () => {
    const withRule = (rule: BehaviorModel["rules"][number]) => {
      const spec = orderModel();
      spec.rules = [rule];
      return spec;
    };
    const effectFinding = (category: FindingCategory, t: string, effect: string): Finding => ({
      ...mismatch(category, t),
      id: `${category}:${BEHAVIOR}:${t}:${effect}`,
    });

    it("links a missing effect to a rule that fewer of it breaks", () => {
      // Every paid order got its receipt; the code never sends it.
      const spec = withRule({
        name: "Paid orders got a receipt",
        kind: "never",
        source: "status == paid and count(effect email.receipt) < 1",
        expr: {
          type: "and",
          left: { type: "status-cmp", op: "==", value: "paid" },
          right: { type: "effect-count", effect: "email.receipt", op: "<", value: 1 },
        },
      });
      const code = codeModel((m) => {
        m.rules = spec.rules;
        transition(m, "payment_succeeded").effects = [];
      });
      const missing = effectFinding("missing-effect", "payment_succeeded", "email.receipt");
      const other = effectFinding("missing-effect", "refund", "stripe.refund");
      const linked = linkRootCauses([missing, other, ...check(code).findings], spec, code);
      const rule = linked.find((f) => f.property === "rule:Paid orders got a receipt");
      expect(rule?.causedBy).toEqual([missing.id]);
    });

    it("never links a missing effect to a rule that only more of it breaks", () => {
      // The trial's case: "never: … and count(effect x) > 0" fails because of an extra step
      // (here, ship from any state), never because the code calls x less.
      // The trace takes a refund step, and the rule counts stripe.refund: only its direction
      // rules the missing effect out.
      const code = codeModel((m) => {
        transition(m, "ship").from = "*";
      });
      const missing = effectFinding("missing-effect", "refund", "stripe.refund");
      const unconstrained = mismatch("from-state-unconstrained", "ship");
      const linked = linkRootCauses(
        [missing, unconstrained, ...check(code).findings],
        orderModel(),
        code,
      );
      const shipped = linked.find((f) => f.property === "rule:Shipped orders are never refunded");
      expect(shipped?.trace?.steps.some((s) => s.action?.transition === "refund")).toBe(true);
      expect(shipped?.causedBy).toEqual([unconstrained.id]);
    });

    it("links an undeclared effect to a rule that more of it breaks", () => {
      const spec = withRule({
        name: "Cancelled orders are never refunded",
        kind: "never",
        source: "status == cancelled and count(effect stripe.refund) > 0",
        expr: {
          type: "and",
          left: { type: "status-cmp", op: "==", value: "cancelled" },
          right: { type: "effect-count", effect: "stripe.refund", op: ">", value: 0 },
        },
      });
      const code = codeModel((m) => {
        m.rules = spec.rules;
        transition(m, "expire").effects = [{ name: "stripe.refund", multiplicity: "exactly-once" }];
      });
      const extra = effectFinding("undeclared-effect", "expire", "stripe.refund");
      const linked = linkRootCauses([extra, ...check(code).findings], spec, code);
      const rule = linked.find((f) => f.property === "rule:Cancelled orders are never refunded");
      expect(rule?.causedBy).toEqual([extra.id]);
    });

    it("never links a missing-effect warning (tsverify couldn't confirm it)", () => {
      const spec = withRule({
        name: "Paid orders got a receipt",
        kind: "always",
        source: "status != paid or count(effect email.receipt) >= 1",
        expr: {
          type: "or",
          left: { type: "status-cmp", op: "!=", value: "paid" },
          right: { type: "effect-count", effect: "email.receipt", op: ">=", value: 1 },
        },
      });
      const code = codeModel((m) => {
        m.rules = spec.rules;
        transition(m, "payment_succeeded").effects = [];
      });
      const unconfirmed: Finding = {
        ...effectFinding("missing-effect", "payment_succeeded", "email.receipt"),
        severity: "warning",
      };
      const linked = linkRootCauses([unconfirmed, ...check(code).findings], spec, code);
      expect(linked.find((f) => f.property === "rule:Paid orders got a receipt")).toBeDefined();
      expect(linked.every((f) => f.causedBy === undefined)).toBe(true);
    });
  });

  describe("code that does less than the spec: liveness counterexamples", () => {
    // Without payment_succeeded and expire, nothing leaves pending_payment: the code model is
    // stuck there (no-stuck-states) and an unpaid order lingers (an `eventually` rule).
    const stuck = () =>
      codeModel((m) => {
        m.transitions = m.transitions.filter(
          (t) => t.name !== "payment_succeeded" && t.name !== "expire",
        );
      });
    const liveness = (findings: readonly Finding[]) =>
      findings.filter((f) => f.trace?.kind === "liveness");

    it("links a missing transition that would leave the state the trace ends in", () => {
      const missing = mismatch("missing-transition", "expire");
      const unrelated = mismatch("missing-transition", "refund"); // leaves paid, not pending_payment
      const linked = link(stuck(), [missing, unrelated]);
      expect(liveness(linked).map((f) => [f.property, f.causedBy])).toEqual([
        ["no-stuck-states", [missing.id]],
        ["rule:Unpaid orders don't linger", [missing.id]],
      ]);
    });

    it("links a transition the code writes only in forms tsverify can't read", () => {
      const unconfirmed: Finding = {
        ...mismatch("unanalyzable", "payment_succeeded"),
        id: `unanalyzable:${BEHAVIOR}:payment_succeeded:unconfirmed`,
        severity: "warning",
      };
      // Another unanalyzable finding on the transition is not a cause.
      const other: Finding = { ...unconfirmed, id: `unanalyzable:${BEHAVIOR}:from-state:x` };
      const linked = link(stuck(), [unconfirmed, other]);
      for (const f of liveness(linked)) expect(f.causedBy).toEqual([unconfirmed.id]);
      expect(liveness(linked)).toHaveLength(2);
    });

    it("links a stricter from-state warning when the code lacks the transition from the end state", () => {
      const code = codeModel((m) => {
        m.transitions = m.transitions.filter((t) => t.name !== "payment_succeeded");
        const expire = transition(m, "expire");
        expire.from = ["draft"];
        expire.sites = { specTransition: "expire" } as CodeSites;
      });
      const stricter: Finding = {
        ...mismatch("from-state-mismatch", "expire"),
        id: `from-state-mismatch:${BEHAVIOR}:expire:pending_payment`,
        severity: "warning",
      };
      const linked = linkRootCauses([stricter, ...check(code).findings], orderModel(), code);
      const stuckAt = liveness(linked);
      expect(stuckAt.length).toBeGreaterThan(0);
      for (const f of stuckAt) expect(f.causedBy).toEqual([stricter.id]);
      // Without the code model, the states it lacks are unknown: no link.
      const unlinked = linkRootCauses([stricter, ...check(code).findings], orderModel());
      for (const f of liveness(unlinked)) expect(f.causedBy).toBeUndefined();
    });

    it("never links a missing transition to an invariant counterexample", () => {
      const missing = mismatch("missing-transition", "refund");
      const linked = link(b3(), [missing]);
      for (const f of linked.filter((x) => x.trace?.kind === "invariant")) {
        expect(f.causedBy).toBeUndefined();
      }
    });
  });

  it("only links implementation-property findings, and only within one behavior", () => {
    const specFinding = check(
      (() => {
        const m = orderModel();
        transition(m, "refund").atomic = false;
        return m;
      })(),
    ).findings;
    expect(specFinding.length).toBeGreaterThan(0);
    const other = { ...mismatch("non-atomic", "refund"), behavior: "Other" };
    const linked = linkRootCauses(
      [mismatch("non-atomic", "refund"), other, ...specFinding, ...check(b3()).findings],
      orderModel(),
    );
    for (const f of linked) {
      if (f.category === "spec-property") expect(f.causedBy).toBeUndefined();
      if (f.category === "implementation-property" && f.trace) {
        expect(f.causedBy).toEqual([`non-atomic:${BEHAVIOR}:refund`]);
      }
    }
  });
});
