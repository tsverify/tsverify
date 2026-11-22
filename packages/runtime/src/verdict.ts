/**
 * How a replay outcome maps onto findings (doc 3, Part C "How the outcomes combine"):
 *
 * | Followed? | Property violated? | Verdict               |
 * |-----------|--------------------|-----------------------|
 * | yes       | yes                | `confirmed`           |
 * | no        | yes                | `confirmed-divergent` |
 * | no        | no                 | `replay-disagrees`    |
 * | yes       | no                 | `replay-disagrees`    |
 *
 * - `confirmed`: the schedule was followed and the real code violates the property. A bug.
 * - `confirmed-divergent`: the code left the schedule but still violated the property (after
 *   draining). A real bug reached through a different interleaving; report the divergence too.
 * - `replay-disagrees`: the property holds in the real code. Either the code is safer than the
 *   trace (diverged, e.g. `blocked` by a lock), or the schedule was followed but the effect never
 *   happened (a mapping or instrumentation gap). A warning with the divergence attached.
 */
import type { DivergenceKind } from "./divergence";
import type { PlayOutcome } from "./scheduler";

export type ReplayVerdict = "confirmed" | "confirmed-divergent" | "replay-disagrees";

export function replayVerdict(r: { followed: boolean; violated: boolean }): ReplayVerdict {
  if (r.violated) return r.followed ? "confirmed" : "confirmed-divergent";
  return "replay-disagrees";
}

/** JSON-safe summary of one replay, for the sidecar file `tsv test` reads back. */
export interface ReplayResult {
  verdict: ReplayVerdict;
  followed: boolean;
  violated: boolean;
  divergence?: { kind: DivergenceKind; stepIndex: number; worker: string; message: string };
}

export function replayResult(outcome: PlayOutcome, violated: boolean): ReplayResult {
  const result: ReplayResult = {
    verdict: replayVerdict({ followed: outcome.followed, violated }),
    followed: outcome.followed,
    violated,
  };
  if (!outcome.followed) {
    const d = outcome.divergence.details;
    result.divergence = {
      kind: d.kind,
      stepIndex: d.stepIndex,
      worker: d.worker,
      message: outcome.divergence.message,
    };
  }
  return result;
}
