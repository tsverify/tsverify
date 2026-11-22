// @tsv/runtime: imported by tests that tsv generates. Zero internal dependencies (doc 6 §2 rule 5).
// See ../README.md for the semantics and the shape of a generated replay test.

import { effects } from "./instrument/effects";
import { prisma } from "./instrument/prisma";
import { store } from "./instrument/store";

export {
  type DivergenceDetails,
  type DivergenceKind,
  formatStep,
  ReplayDivergence,
  type Step,
  type WorkerSnapshot,
} from "./divergence";
export type { GateEvent, GateKind } from "./gates";
export type { EffectMethod, EffectsClient, EffectsConfig, EffectsFake } from "./instrument/effects";
export {
  PRISMA_METHODS,
  type PrismaDelegate,
  type PrismaDelegateMethod,
  type PrismaFake,
  type PrismaFakeClient,
  type PrismaFakeConfig,
  PrismaFakeError,
  type PrismaMethod,
  type PrismaModelConfig,
} from "./instrument/prisma";
export type {
  CollectionConfig,
  CommitMethod,
  ReadMethod,
  Row,
  StoreClient,
  StoreCollections,
  StoreConfig,
  StoreFake,
} from "./instrument/store";
export { UninstrumentedCallError } from "./instrument/strict";
export {
  type ModelActionKind,
  type PlannedWorker,
  type PlanOptions,
  planFromTrace,
  type ReplayMapping,
  type ReplayPlan,
  type TraceInput,
  type TraceStepInput,
} from "./plan";
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
export {
  type CallSiteInput,
  type CodeModelInput,
  type CodeSitesInput,
  effectsConfigFromCode,
  mappingFromCode,
  prismaConfigFromCode,
  storeConfigFromCode,
} from "./sites";
export { type ReplayResult, type ReplayVerdict, replayResult, replayVerdict } from "./verdict";

/** In-memory fakes for the app's clients. `fake.client` is what a `vi.mock` factory exports. */
export const instrument = { store, prisma, effects };
