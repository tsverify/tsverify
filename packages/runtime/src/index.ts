// @tsv/runtime: imported by tests that tsv generates. Zero internal dependencies (doc 6 §2 rule 5).
// See ../README.md for the semantics and the shape of a generated replay test.

export {
  type DivergenceDetails,
  type DivergenceKind,
  formatStep,
  ReplayDivergence,
  type Step,
  type WorkerSnapshot,
} from "./divergence";
export type { GateEvent, GateKind } from "./gates";
export {
  type EffectCall,
  type Outcome,
  type PlayOutcome,
  type PlayReport,
  type Schedule,
  Scheduler,
  type SchedulerOptions,
  scheduler,
  UNTIL_DONE,
  type WorkerStatus,
} from "./scheduler";
export { type ReplayResult, type ReplayVerdict, replayResult, replayVerdict } from "./verdict";
