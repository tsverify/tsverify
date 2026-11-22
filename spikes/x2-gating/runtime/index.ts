// Prototype of `@tsverify/runtime` (spike X2). See ../README.md.

export {
  type DivergenceDetails,
  type DivergenceKind,
  formatStep,
  ReplayDivergence,
  type WorkerSnapshot,
} from "./divergence";
export {
  planFromTrace,
  type ReplayMapping,
  type ReplayVerdict,
  replayVerdict,
  type TraceReplayPlan,
} from "./from-trace";
export {
  type EffectsFake,
  type EffectsOptions,
  instrument,
  type Repo,
  type Row,
  type StoreClient,
  type StoreFake,
  type StoreOptions,
} from "./instrument";
export {
  type EffectCall,
  type GateEvent,
  type GateKind,
  type Outcome,
  type PlayOutcome,
  type PlayReport,
  type Schedule,
  Scheduler,
  type SchedulerOptions,
  type Step,
  scheduler,
  UNTIL_DONE,
  type WorkerState,
} from "./scheduler";
