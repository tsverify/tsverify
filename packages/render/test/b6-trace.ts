import type { Trace, TraceAction, TraceStep, WorkerPhase, WorkerState } from "@tsv/ir";

/**
 * Hand-built B6 counterexample on the non-atomic refund variant: two refunds both read `paid`
 * before either writes, so `stripe.refund` fires twice. Built here rather than by the checker
 * so render tests do not depend on `@tsv/checker`.
 */
export function b6DoubleRefundTrace(): Trace {
  const workers: WorkerState[] = [
    { id: "checkout#1", transition: "checkout", phase: "idle" },
    { id: "checkout#2", transition: "checkout", phase: "idle" },
    { id: "payment_succeeded#1", transition: "payment_succeeded", phase: "idle" },
    { id: "payment_succeeded#2", transition: "payment_succeeded", phase: "idle" },
    { id: "refund#1", transition: "refund", phase: "idle" },
    { id: "refund#2", transition: "refund", phase: "idle" },
  ];
  let status = "draft";
  const effects: Record<string, number> = { "email.receipt": 0, "stripe.refund": 0 };
  const steps: TraceStep[] = [snapshot(0)];

  function snapshot(index: number, action?: TraceAction): TraceStep {
    const state = { status, effects: { ...effects }, workers: workers.map((w) => ({ ...w })) };
    return action ? { index, action, state } : { index, state };
  }

  function act(
    worker: string,
    kind: TraceAction["kind"],
    phase: WorkerPhase,
    change: { to?: string; effect?: string } = {},
  ): void {
    const w = workers.find((x) => x.id === worker);
    if (!w) throw new Error(`unknown worker ${worker}`);
    if (kind === "read") w.observed = status;
    w.phase = phase;
    if (change.to) status = change.to;
    if (change.effect) effects[change.effect] = (effects[change.effect] ?? 0) + 1;
    const action: TraceAction = { worker, transition: w.transition, kind };
    if (kind !== "write") action.outcome = "proceed";
    steps.push(snapshot(steps.length, action));
  }

  act("checkout#1", "read", "checked");
  act("checkout#1", "write", "done", { to: "pending_payment" });
  act("payment_succeeded#1", "atomic", "done", { to: "paid", effect: "email.receipt" });
  act("refund#1", "read", "checked");
  act("refund#2", "read", "checked");
  act("refund#1", "write", "done", { to: "refunded", effect: "stripe.refund" });
  act("refund#2", "write", "done", { to: "refunded", effect: "stripe.refund" });

  return {
    behavior: "Order lifecycle",
    model: "spec",
    property: "effect-multiplicity",
    kind: "invariant",
    steps,
  };
}
