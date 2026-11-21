import type { BehaviorModel, Transition } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import { describe, expect, it } from "vitest";
import { buildLayout, decodeState, initialState, STATUS } from "./encode";
import { type Action, applyAction, buildActions, isBudgetLimited, isEnabled } from "./semantics";

/** The canonical model with `checkout` non-atomic, so both action shapes are exercised. */
function model(): BehaviorModel {
  const m = orderModel();
  const checkout = m.transitions.find((t) => t.name === "checkout");
  if (checkout) checkout.atomic = false;
  m.rules.push({
    name: "few receipts",
    kind: "always",
    source: "count(effect email.receipt) < 4",
    expr: { type: "effect-count", effect: "email.receipt", op: "<", value: 4 },
  });
  return m;
}

function action(actions: readonly Action[], transition: string, kind: Action["kind"]): Action {
  const a = actions.find((a) => a.transition.name === transition && a.kind === kind);
  if (!a) throw new Error(`no ${kind} ${transition}`);
  return a;
}

function step(a: Action, s: Uint16Array): Uint16Array {
  expect(isEnabled(a, s)).toBe(true);
  const next = s.slice();
  applyAction(a, next);
  return next;
}

describe("layout", () => {
  it("allocates status, worker classes and saturating effect counts", () => {
    const layout = buildLayout(model());
    // status + 5 idle fields + checked(draft) for non-atomic checkout + 2 effects
    expect(layout.width).toBe(1 + 5 + 1 + 2);
    expect(layout.effects.map((e) => [e.name, e.cap, e.emitters])).toEqual([
      ["email.receipt", 5, ["payment_succeeded"]],
      ["stripe.refund", 2, ["refund"]],
    ]);
    const s = initialState(layout);
    expect(decodeState(layout, s)).toEqual({
      status: "draft",
      effects: { "email.receipt": 0, "stripe.refund": 0 },
    });
  });

  it("rejects a transition without a concurrency bound", () => {
    const m = model();
    delete m.concurrency.refund;
    expect(() => buildLayout(m)).toThrow(/concurrency/);
  });
});

describe("actions", () => {
  const layout = buildLayout(model());
  const actions = buildActions(layout);

  it("are atomic, or read + one write per observable status, in model order", () => {
    expect(actions.map((a) => `${a.kind}:${a.transition.name}`)).toEqual([
      "read:checkout",
      "write:checkout",
      "atomic:expire",
      "atomic:payment_succeeded",
      "atomic:refund",
      "atomic:ship",
    ]);
  });

  it("disabled attempts are not actions and consume no worker", () => {
    const s = initialState(layout);
    expect(isEnabled(action(actions, "refund", "atomic"), s)).toBe(false);
    expect(isEnabled(action(actions, "checkout", "write"), s)).toBe(false);
  });

  it("read records the observation; write sets status without re-checking", () => {
    const read = action(actions, "checkout", "read");
    const write = action(actions, "checkout", "write");
    const pay = action(actions, "payment_succeeded", "atomic");
    let s = step(read, initialState(layout));
    s = step(read, s);
    expect(s[read.field]).toBe(0);
    expect(s[write.field]).toBe(2);
    s = step(write, s);
    s = step(pay, s);
    expect(decodeState(layout, s).status).toBe("paid");
    // The second checkout observed `draft` long ago; its write still happens.
    s = step(write, s);
    expect(decodeState(layout, s)).toEqual({
      status: "pending_payment",
      effects: { "email.receipt": 1, "stripe.refund": 0 },
    });
  });

  it("saturates effect counts at the cap", () => {
    const m = model();
    const ps = m.transitions.find((t) => t.name === "payment_succeeded") as Transition;
    ps.from = "*";
    m.concurrency.payment_succeeded = 9;
    m.rules = [];
    const l = buildLayout(m);
    const pay = action(buildActions(l), "payment_succeeded", "atomic");
    let s = initialState(l);
    for (let i = 0; i < 9; i++) s = step(pay, s);
    expect(decodeState(l, s).effects["email.receipt"]).toBe(2);
  });

  it("classifies deadlocks as budget-limited when some transition could still fire", () => {
    const s = initialState(layout);
    expect(isBudgetLimited(layout, s)).toBe(true);
    s[STATUS] = layout.stateIndex.get("shipped") as number;
    expect(isBudgetLimited(layout, s)).toBe(false);
  });
});
