import { check } from "@tsv/checker";
import type { BehaviorModel, Finding, FindingCategory, Transition } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
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
