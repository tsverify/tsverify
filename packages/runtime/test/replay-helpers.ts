import type { Scheduler } from "../src/index";

/** Repetitions for the determinism checks (spike X2 used 100). */
export const RUNS = 100;

/** Mini-app order row (test/mini-app/db.ts). */
export function paidOrder(status = "paid") {
  return { id: "o1", status, chargeId: "ch_1", amount: 4200 };
}

/**
 * Everything observable about one replay run. Two runs are "identical" when their fingerprints
 * are deep-equal: same gate order, same effect calls, same final rows, same worker outcomes.
 */
export function fingerprint(s: Scheduler, rows: unknown, workers: readonly string[]) {
  return {
    gates: gateTrail(s),
    effects: s.effects().map((e) => ({ worker: e.worker, effect: e.effect, args: e.args })),
    rows,
    outcomes: workers.map((w) => {
      const o = s.outcome(w);
      return o.status === "failed" ? { status: "failed", error: String(o.error) } : o;
    }),
  };
}

/** `worker:gate` for every gate passed, in order. */
export function gateTrail(s: Scheduler): string[] {
  return s.gateLog().map((e) => `${e.worker}:${e.gate}`);
}
