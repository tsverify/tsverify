import type { Scheduler } from "../runtime/index";

export const RUNS = 100;

export function paidOrder(status = "paid") {
  return { id: "o1", status, chargeId: "ch_1", amount: 4200 };
}

/**
 * Everything observable about one replay run. Two runs are "identical" when their fingerprints
 * are deep-equal: same gate order, same effect calls, same final rows, same worker outcomes.
 */
export function fingerprint(s: Scheduler, rows: unknown, workers: string[]) {
  return {
    gates: s.gateLog().map((e) => `${e.worker}:${e.gate}`),
    effects: s.effects().map((e) => ({ worker: e.worker, effect: e.effect, args: e.args })),
    rows,
    outcomes: workers.map((w) => s.outcome(w)),
  };
}
