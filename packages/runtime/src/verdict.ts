/**
 * How a replay outcome maps onto findings:
 *
 * | Followed? | Property violated? | Verdict               |
 * |-----------|--------------------|-----------------------|
 * | yes       | yes                | `confirmed`           |
 * | no        | yes                | `confirmed-divergent` |
 * | no        | no                 | `replay-disagrees`    |
 * | yes       | no                 | `replay-disagrees`    |
 * | either    | not evaluable      | `inconclusive`        |
 *
 * - `confirmed`: the schedule was followed and the real code violates the property. A bug.
 * - `confirmed-divergent`: the code left the schedule but still violated the property (after
 *   draining). A real bug reached through a different interleaving; report the divergence too.
 * - `replay-disagrees`: the property holds in the real code. Either the code is safer than the
 *   trace (diverged, e.g. `blocked` by a lock), or the schedule was followed but the effect never
 *   happened: a step was a no-op in the code (e.g. a conditional update that matched
 *   nothing) or a mapping/instrumentation gap. A warning with the divergence attached.
 * - `inconclusive`: the caller cannot evaluate the property from one finished replay (`violated`
 *   is `undefined`), e.g. a liveness rule. The replay still ran; report it as info.
 */
import type { DivergenceKind } from "./divergence.js";
import type { PlayOutcome } from "./scheduler.js";

export type ReplayVerdict =
  | "confirmed"
  | "confirmed-divergent"
  | "replay-disagrees"
  | "inconclusive";

/** `violated: undefined` (or absent): the property could not be evaluated → `inconclusive`. */
export function replayVerdict(r: {
  followed: boolean;
  violated?: boolean | undefined;
}): ReplayVerdict {
  if (r.violated === undefined) return "inconclusive";
  if (r.violated) return r.followed ? "confirmed" : "confirmed-divergent";
  return "replay-disagrees";
}

/** JSON-safe summary of one replay, for the sidecar file `tsverify test` reads back. */
export interface ReplayResult {
  verdict: ReplayVerdict;
  followed: boolean;
  /** Absent when the verdict is `inconclusive`. */
  violated?: boolean;
  divergence?: { kind: DivergenceKind; stepIndex: number; worker: string; message: string };
}

/** @param violated whether the property is violated; `undefined` when it cannot be evaluated. */
export function replayResult(outcome: PlayOutcome, violated: boolean | undefined): ReplayResult {
  const result: ReplayResult = {
    verdict: replayVerdict({ followed: outcome.followed, violated }),
    followed: outcome.followed,
  };
  if (violated !== undefined) result.violated = violated;
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
