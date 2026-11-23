// @tsverify/runtime: imported by tests that tsverify generates. Zero internal dependencies.
// See ../DESIGN.md for the semantics and the shape of a generated replay test.

import { effects } from "./instrument/effects.js";
import { prisma } from "./instrument/prisma.js";
import { storage } from "./instrument/storage.js";
import { store } from "./instrument/store.js";

export {
  type DivergenceDetails,
  type DivergenceKind,
  formatStep,
  ReplayDivergence,
  type Step,
  type WorkerSnapshot,
} from "./divergence.js";
export type { GateEvent, GateKind } from "./gates.js";
export type {
  EffectMethod,
  EffectsClient,
  EffectsConfig,
  EffectsFake,
} from "./instrument/effects.js";
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
} from "./instrument/prisma.js";
export {
  STORAGE_CLIENT,
  type StorageBindingInput,
  StorageConditionError,
  type StorageFake,
  type StorageFakeConfig,
  type StorageFunctionImpl,
  type StorageFunctionInput,
  type StorageRoleInput,
} from "./instrument/storage.js";
export type {
  CollectionConfig,
  CommitMethod,
  ReadMethod,
  Row,
  StoreClient,
  StoreCollections,
  StoreConfig,
  StoreFake,
} from "./instrument/store.js";
export { UninstrumentedCallError } from "./instrument/strict.js";
export {
  type ModelActionKind,
  type PlannedWorker,
  type PlanOptions,
  planFromTrace,
  type ReplayMapping,
  type ReplayPlan,
  type TraceInput,
  type TraceStepInput,
} from "./plan.js";
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
} from "./scheduler.js";
export {
  type CallSiteInput,
  type CodeModelInput,
  type CodeSitesInput,
  effectsConfigFromCode,
  mappingFromCode,
  prismaConfigFromCode,
  storeConfigFromCode,
} from "./sites.js";
export { type ReplayResult, type ReplayVerdict, replayResult, replayVerdict } from "./verdict.js";

/**
 * In-memory fakes for the app's clients. `fake.client` is what a `vi.mock` factory exports;
 * for `storage`, `fake.functions[symbol]` replaces each of the app's storage functions.
 */
export const instrument = { store, prisma, effects, storage };
