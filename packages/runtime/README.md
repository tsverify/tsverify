# @tsverify/runtime

Imported by the tests `tsverify` generates inside a user's project. It replays a model-checker
counterexample (`ir.Trace`) against the real application code: the app's client modules are
replaced (`vi.mock`) by instrumented in-memory fakes, and every call on them passes through a
**gate** that a scheduler opens in the order the counterexample dictates.

Proven in [spike X2](../../spikes/x2-gating/README.md); this package is its production port.

- **Zero internal dependencies** (doc 6 §2 rule 5): it runs inside the user's test process. Inputs
  that come from `@tsverify/ir` (`Trace`, `CodeSites`) are declared as structural types;
  `test/ir-compat.test.ts` proves the `ir` types are assignable.
- **Framework-agnostic.** Nothing here imports vitest. The `vi.mock` wiring lives in the generated
  test.
- **One copy per process.** The worker identity is an `AsyncLocalStorage` in `src/context.ts`;
  the test file and the mock factories must load the same `@tsverify/runtime`.
- **Real timers only.** Generated tests must not enable fake timers. The step timeout uses timers
  captured at import, so fake timers cannot disable it, and a timeout message says when fake
  timers are installed.

## API

```ts
import {
  scheduler, instrument,                                   // replay
  planFromTrace, mappingFromCode,                          // counterexample → schedule
  storeConfigFromCode, prismaConfigFromCode, effectsConfigFromCode, // CodeSites → fake configs
  replayVerdict, replayResult,                             // outcome → verdict
  ReplayDivergence, UninstrumentedCallError, UNTIL_DONE,
} from "@tsverify/runtime";

scheduler(options?: { stepTimeoutMs?: number })   // default 2000 ms
  → Scheduler {
      spawn(id, fn): void                         // register; starts lazily
      play(schedule): Promise<PlayReport>         // throws ReplayDivergence
      tryPlay(schedule): Promise<{ followed: true; report } | { followed: false; divergence }>
      drain(): Promise<void>                      // finish all workers in spawn order; throws `deadlock`
      reset(): void                               // new run: workers, logs, locks cleared; fakes re-seeded
      outcome(id): { status: "done"; value } | { status: "failed"; error } | { status: "unfinished"; state }
      effects(label?): EffectCall[]               // { seq, worker | null, effect, args }
      gateLog(): GateEvent[]                      // { seq, worker, gate, args }, in pass order
      snapshot(): WorkerSnapshot[]
      knownGates(): string[]
      // instrument API (used by fakes, not by tests): defineGate, gate, lock, recordEffect, onReset
    }

instrument.store(s, {
  client: "db",                                   // gate prefix = Bindings.clients key
  collections: { orders: { key: "id", seed?: Row[] } },
  read: ["orders.get"],                           // (key) => row copy        — sync gates
  commit: ["orders.save"],                        // (row) => upsert by key   — sync gates
  transaction?: "transaction",                    // (fn(tx)) => result        — transparent gate
  missing?: "undefined" | ((collection, key) => Error),   // read of a missing key
}) → { client, seed({ orders: rows }), read(collection, key), rows(collection) }

instrument.prisma(s, {
  client: "db",                                   // gate prefix = Bindings.clients key
  models: { order: { key: "id", seed?: Row[] } }, // model delegates: db.order.<method>(args)
  read: ["order.findUnique"],                     // sync gates (every other delegate method: transparent)
  write: ["order.update", "order.updateMany"],    // sync gates; updateMany = one compare-and-set
}) → { client, seed({ order: rows }), read(model, key), rows(model) }   // client.$transaction(fn | [ops], options?)

instrument.effects(s, {
  client: "stripe",
  calls: ["refunds.create"],                      // nested paths → client.refunds.create(...)
  returns?: { "refunds.create": (args, n) => ({ id: `re_${n}` }) },  // default { id: "refunds_create_fake_<n>" }
  gate?: "transparent" | "sync",                  // default transparent
}) → { client, calls(path): EffectCall[] }

mappingFromCode(codeModel) → ReplayMapping       // { transitions: { t: { read, write, atomic: gate[] } }, effects }
planFromTrace(trace, mapping, { fastForward? = true } | { replayFrom: stepIndex }) → ReplayPlan
  // { property, startIndex, seedStatus, seedEffects, skipped, workers, schedule, origins, expectedEffects }
storeConfigFromCode(codeModel, "db") / prismaConfigFromCode(codeModel, "db") / effectsConfigFromCode(codeModel, "stripe")

replayVerdict({ followed, violated }) → "confirmed" | "confirmed-divergent" | "replay-disagrees" | "inconclusive"
replayResult(playOutcome, violated | undefined) → { verdict, followed, violated?, divergence?: { kind, stepIndex, worker, message } }
```

## Scheduler semantics

**Workers.** `spawn(id, fn)` only registers a worker; the code before its first gate runs as part
of the first step that schedules it. `fn` runs inside the worker's async context, which follows
every `await`, promise continuation and timer it creates. Worker status (`WorkerStatus`):

| Status | Meaning | Resumable |
|---|---|---|
| `spawned` | registered, not started | yes: starts `fn` |
| `running` | its code is executing — **at most one worker at a time** | — |
| `parked` | called an instrumented method, suspended *before* the call does anything | yes: the call executes ("passes" the gate) |
| `waiting` | blocked on a lock held by another worker | **no** |
| `ready` | was waiting; now holds the lock, has not run since | yes |
| `done` / `failed` | `fn` returned / threw | no |

The lifecycle is specified in [`src/scheduler.behavior.yaml`](src/scheduler.behavior.yaml)
(dogfooding, doc 6 §6); each status change is one method of `Scheduler`.

A step resumes exactly one worker and waits until it **stops running** (parks, waits, or settles),
learned from events, never by counting microtasks. After it stops, the step lets one macrotask
turn pass so that anything else the worker started (a `Promise.race` branch, a fire-and-forget
call) is caught as a stray instead of leaking into a later step. Unrelated awaits, `setImmediate`
or real `setTimeout` inside the running worker don't change the run.

**Gates.** Labels are client call paths (`<client>.<path>`), the same string as `CallSite.gate`.

| Kind | Examples | Rule |
|---|---|---|
| `sync` | `db.orders.get`, `db.orders.save` | model read/write points; a step can only pass the sync gate it names |
| `transparent` | `db.transaction`, `stripe.refunds.create` | passed automatically on the way to the named gate; can also be named to stop there |

**Step `[w, G]` = "pass through G".** Resume `w` if it is `spawned`/`ready`; while it is parked at
a transparent gate other than `G`, pass it; when it is parked at `G`, pass `G` and wait until it
stops again. Anything else is a divergence. `[w, "until-done"]` passes every gate until `fn`
settles (a throw is a valid outcome there). Calls outside any worker (seeding, setup) pass straight
through.

**Locks.** Passing a store's transaction gate requests one FIFO mutex per store. A held lock makes
the worker `waiting` and ends the step. The holder releases it inside its own step (after commit or
rollback); the next waiter becomes `ready` and does **not** run until a step or `drain` resumes it.
So the mutex never runs a worker behind the schedule's back.

### Divergences

`play` throws `ReplayDivergence` (`tryPlay` returns it) with `details`: kind, step index, worker,
expected, actual, a snapshot of every worker and the completed steps. Example:

```
Replay diverged at step 2/6 ["refund#2", "db.orders.get"]: blocked
  refund#2 is waiting for "db.transaction" held by refund#1 (parked at "db.orders.save") and cannot reach "db.orders.get" until refund#1 releases it. The code serialises these workers more strictly than the schedule assumes.
Workers:
  refund#1  parked at "db.orders.save"   passed: db.transaction → db.orders.get
  refund#2  waiting for "db.transaction" (held by refund#1)   passed: db.transaction
Completed steps:
  1. ["refund#1", "db.orders.get"]
```

| Kind | When |
|---|---|
| `invalid-schedule` | unknown worker or gate (typo); checked before anything runs, lists the known gates |
| `finished-early` | the worker returned without reaching the named gate |
| `threw` | the worker threw before reaching it (`details.cause`) |
| `different-gate` | the worker's next sync gate is another one |
| `blocked` | the worker is `waiting` for a lock held by another worker |
| `deadlock` | a wait-for cycle, or `drain` with only waiting workers |
| `timeout` | the resumed worker neither parked nor settled within `stepTimeoutMs` |
| `stray-gate` | a gate call (or a settlement) by a worker that wasn't running: `Promise.all`/`race` over gated calls, fire-and-forget work, a callback from a reset run. Never let through |

### Verdicts

Generated tests `tryPlay`, then `drain`, then evaluate the violated property in code terms, then
call `replayVerdict` / `replayResult`:

| Followed? | Violated? | Verdict | Report |
|---|---|---|---|
| yes | yes | `confirmed` | implementation bug: the test fails |
| no | yes | `confirmed-divergent` | bug through another interleaving: fail, attach the divergence |
| no | no | `replay-disagrees` | the code is safer than the trace (e.g. `blocked`): warning |
| yes | no | `replay-disagrees` | mapping or instrumentation gap: warning |
| either | `undefined` | `inconclusive` | the property is not evaluable from one replay (e.g. liveness): info |

Pass `violated: undefined` when the property cannot be evaluated in code terms; the result then
has no `violated` field, and the divergence (if any) is still attached.

## Fakes

`instrument.store` models the `assign` persistence pattern. Reads and commits happen when the gate
is *passed* (a read sees the rows at pass time). Copy on read and copy on write
(`structuredClone`). Inside `transaction(fn)`, reads see staged rows first; staged writes are
applied when `fn` resolves and dropped when it throws. Not reentrant (a nested transaction is a
`deadlock`). Config seeds are re-applied on every `reset()`; `seed()` rows last one run.

`instrument.prisma` models the `prisma` persistence pattern with the call shapes of a generated
`PrismaClient` (`src/instrument/prisma.ts` has the full rules):

- Every configured model gets the standard delegate methods (`findUnique(OrThrow)`,
  `findFirst(OrThrow)`, `findMany`, `count`, `create`, `update`, `updateMany`, `upsert`, `delete`,
  `deleteMany`). The `read` / `write` paths are sync gates, the others transparent. Each operation
  runs in one synchronous step once its gate is passed, so `updateMany` (and an `update` with the
  state in `where`) is an **atomic compare-and-set**, like the single SQL statement.
- `where` supports equality, `equals` / `in` / `notIn` / `not` / comparisons / string filters and
  `AND` / `OR` / `NOT`; `data` supports values and `set` / `increment` / `decrement` / `multiply` /
  `divide`; `select` projects. Relations throw. Missing rows: `null`, or `PrismaFakeError` `P2025`
  (`…OrThrow`, `update`, `delete`); `updateMany` returns `{ count: 0 }`.
- Calls return lazy PrismaPromises (nothing runs until awaited or passed to `$transaction([…])`),
  bound to the worker that made the call.
- `$transaction` is a transparent gate. With `isolationLevel: "Serializable"` (interactive or
  array form) it holds one scheduler lock per client, like the store's transaction. At any other
  level (the default) it takes **no** lock: a read-then-write inside it interleaves with another
  worker, so a replay shows the race the database would allow. Writes apply when their gate is
  passed and are undone if the transaction fails.

All fakes are **strict**: a member the config doesn't list is a stub that throws
`UninstrumentedCallError` when called, e.g.

```
db.orders.list is not instrumented: the store fake for client "db" knows db.orders.get (read),
db.orders.save (commit), db.transaction (transaction). Add "orders.list" to `read` (…) or to `commit` (…).
```

Probes by `await`, `JSON.stringify`, `expect` and loggers (`then`, `toJSON`, symbols, …) still work.

## From a counterexample to a schedule

`mappingFromCode(codeModel)` reads each linked code transition's `CodeSites`: `read` → `read.gate`,
`write` → `commit.gate`, `atomic` → both. The atomic scope's gate (`db.transaction`) and effect
gates are transparent, so the **same schedule** drives code with or without a transaction; whether
the code serialises the workers is what the replay finds out.

`planFromTrace(trace, mapping)` fast-forwards the leading atomic actions (and actions on unmapped
transitions) by seeding `seedStatus`, refuses when a worker is in flight at that point, maps each
remaining action to its gates, and appends `until-done` for every worker. When that leaves nothing
(an all-atomic trace, such as B4's duplicate webhook), it throws; choose the first replayed step
with `{ replayFrom: i }` instead: every step before `i` is seeded whatever its kind (B1: the
unmapped `reopenOrder` at step 3, so `replayFrom: 4`), the same in-flight check applies, and every
step from `i` on must be mapped. `{ fastForward: false }` is `{ replayFrom: 1 }`. `seedEffects`
are the prefix's effect counts (add them when evaluating a count rule); `expectedEffects` are the
model's counts for the replayed part. For `b6-refund-race` against the orders app:

```
skipped: checkout#1 (atomic), payment_succeeded#1 (atomic)      seedStatus: paid
schedule: [refund#1, db.orders.get] [refund#2, db.orders.get] [refund#1, db.orders.save]
          [refund#2, db.orders.save] [refund#1, until-done] [refund#2, until-done]
```

Clean app → `blocked` at step 2, Stripe ×1, `replay-disagrees`. B3 variant → followed, Stripe ×2,
`confirmed` (`test/orders-app-replay.test.ts`, 100/100 identical runs each).

## Shape of a generated replay test

Executable version against the demo app: [`test/generated-shape.test.ts`](test/generated-shape.test.ts).
Testgen may not import this package (doc 6 §2 rule 2), so the generated file plans at test time
from JSON sidecars (the trace and the `CodeSites` subset); both import without a cast.

```ts
import { expect, test, vi } from "vitest";
import { instrument, mappingFromCode, planFromTrace, type ReplayResult, replayResult, scheduler } from "@tsverify/runtime";
import code from "./refund-race.code.json" with { type: "json" };   // CodeSites subset
import trace from "./refund-race.trace.json" with { type: "json" };

declare module "vitest" {
  interface TaskMeta { tsverifyReplay?: ReplayResult }                 // read back by `tsverify test`
}

// (1) Fakes as plain top-level consts (vi.mock is hoisted, but its factory runs lazily).
const s = scheduler();
const db = instrument.store(s, {
  client: "db",
  collections: { orders: { key: "id" } },
  read: ["orders.get"],
  commit: ["orders.save"],
  transaction: "transaction",
});
const stripe = instrument.effects(s, { client: "stripe", calls: ["refunds.create"] });

// (2) Mock the modules that construct the clients (Bindings.clients), relative to this file.
vi.mock("../../src/db", () => ({ db: db.client }));
vi.mock("../../src/payments/stripe", () => ({ stripe: stripe.client }));

// (3) The impl, imported DYNAMICALLY after (1). A static import breaks the mock factories.
const { refundOrder } = await import("../../src/orders/refund");

const plan = planFromTrace(trace, mappingFromCode(code));
// trace steps 1-2 (checkout#1, payment_succeeded#1) fast-forwarded: seed status "paid"
// [refund#1, db.orders.get]   step 3  refund#1 read
// [refund#2, db.orders.get]   step 4  refund#2 read
// [refund#1, db.orders.save]  step 5  refund#1 write
// [refund#2, db.orders.save]  step 6  refund#2 write

test("replay: Refund issued at most once per order (refund#1 ∥ refund#2)", async ({ task }) => {
  s.reset();
  db.seed({ orders: [{ id: "order_1", ownerId: "user_1", email: "user_1@example.test", status: plan.seedStatus, chargeId: "ch_1" }] });
  const actor = { id: "admin_1", roles: ["admin"] as const };  // actor `admin`: requires role(admin)
  for (const w of plan.workers) s.spawn(w.id, () => refundOrder({ actor }, "order_1")); // InvocationShape
  const outcome = await s.tryPlay(plan.schedule);
  await s.drain();
  const refunds = (plan.seedEffects["stripe.refunds.create"] ?? 0) + stripe.calls("refunds.create").length;
  const result = replayResult(outcome, !(refunds <= 1));       // count(effect stripe.refund) <= 1
  task.meta.tsverifyReplay = result;
  expect(result.violated, `${result.verdict}\n${result.divergence?.message ?? ""}`).toBe(false);
});
```

Against the clean app this passes with `tsverifyReplay.verdict = "replay-disagrees"` (a warning for
`tsverify test` to report); against B3 the assertion fails with the verdict `confirmed`. Per file: no
fake timers, no `setupFiles` that import app code, one run per test. What testgen fills in: the
fake configs (or `storeConfigFromCode` / `effectsConfigFromCode` on the sidecar), the client
module paths from `Bindings.clients`, the impl from `InvocationShape.impl`, the call from
`InvocationShape` (entity id and actor argument paths), the seed row (status from the plan, the
other fields from a fixture), an actor fixture satisfying the transition's guards, and the
violated rule compiled to code terms.

## Limits

From the spike, still true: only gated clients are ordered (every client touching shared state
must be faked); concurrent gated calls inside one worker are `stray-gate`; `worker_threads` and
child processes are out of scope; the store's transaction is a serializable mutex, so a fake that
is stronger than the real isolation level reports a false `replay-disagrees` (the Prisma fake
locks only Serializable transactions, and lets other workers see a transaction's writes before it
commits, which is stronger visibility than READ COMMITTED, never weaker);
fast-forwarding assumes the status is all of the relevant model state.
