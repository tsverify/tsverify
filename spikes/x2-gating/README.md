# Spike X2: gating

**Question** ([plan §8](../../idea/4.%20prototype-plan.md)): can `vi.mock` + `AsyncLocalStorage` +
gates on instrumented clients force a specific interleaving of real async code, deterministically?

**Answer: yes, go.** A replay of the B3 race against unmodified application code refunds twice in
100/100 runs. The fixed code refunds once in 100/100 runs. Every run produces an identical
fingerprint (gate order, effect calls with arguments, final rows and worker outcomes). The golden
`b6-refund-race` counterexample from `packages/checker` drives the same replay through a small
mapping table. When a schedule can't be followed, the replay fails with a precise, typed error and
never diverges silently. The caveats are in [Limits](#limits).

```
pnpm exec vitest run --root spikes/x2-gating                         # 26 tests, ~1 s
pnpm exec tsc -p spikes/x2-gating/tsconfig.json --noEmit
```

The root CI doesn't include this directory. Biome lints it.

## Layout

| Path | What |
|---|---|
| `app/db.ts` | In-memory order repository: `db.orders.get/save` and `db.transaction(fn)`, which is serialised by a mutex and applies staged writes on commit |
| `app/stripe.ts` | Stripe stand-in: `stripe.refunds.create` |
| `app/audit.ts` | Helper that is **not mocked**. It awaits microtasks and one `setImmediate`, as noise |
| `app/refund-buggy.ts` | B3: `get` → check `paid` → `auditNote` → `stripe.refunds.create` → `save`. Non-atomic |
| `app/refund-fixed.ts` | Check and write inside `db.transaction`. Stripe is called only if this worker won the transition |
| `runtime/scheduler.ts` | `scheduler()`, workers, gates, the scheduler-aware lock, `play`/`tryPlay`/`drain` |
| `runtime/instrument.ts` | `instrument.store(...)` and `instrument.effects(...)` |
| `runtime/divergence.ts` | `ReplayDivergence`: kinds and message format |
| `runtime/from-trace.ts` | `planFromTrace(trace, mapping)` and `replayVerdict(...)` |
| `test/b3-buggy.test.ts` | B3 against the buggy code (this is roughly what testgen would emit) |
| `test/b3-fixed.test.ts` | B3 against the fixed code: adapted schedule, unadapted schedule (`blocked`), and the replay-disagrees flow |
| `test/diagnostics.test.ts` | One test per divergence kind, plus the noise the scheduler tolerates |
| `test/trace.test.ts` | Replay driven by `packages/checker/test/__golden__/b6-refund-race.trace.json` |
| `test/app.test.ts` | The app runs without the runtime or any mocks |

## Scheduler semantics

**Workers.** `s.spawn(id, fn)` only registers a worker. A worker starts the first time a step (or
`drain`) schedules it, and the code before its first gate runs as part of that step. `fn` runs
inside `AsyncLocalStorage.run({ scheduler, generation, worker })`. That context follows every
`await`, promise continuation and timer the worker creates, so a gate always knows which worker is
calling.

**One worker runs at a time.** Between steps, every worker is in one of these states:

| State | Meaning | Resumable |
|---|---|---|
| `new` | spawned, not started | yes: starts `fn` |
| `parked` at gate G | called an instrumented method and is suspended *before* the call does anything | yes: the call executes (it "passes" G) |
| `waiting` for R | blocked on a resource (the transaction lock) held by another worker | **no** |
| `ready` | was waiting; it now holds R but has not run since | yes |
| `done` / `failed` | `fn` returned or threw | no |

A step resumes exactly one worker and waits **until that worker stops running**: it parks at its
next gate, waits for a resource, or settles. The scheduler learns this from events: the gate call,
the lock, and the settlement of `fn`. It does not count microtasks or poll. That is why unrelated
awaits in the running worker (`await Promise.resolve()`, an unmocked async helper, `setImmediate`,
even a real `setTimeout`) don't affect the result, and why the same schedule always produces the
same run.

**Gates.** Every method on an instrumented client calls `s.gate(label, args)` before it does any
work. Outside a worker (test setup, seeding) the gate passes straight through. There are two kinds:

| Kind | Gates in this spike | Rule |
|---|---|---|
| `sync` | `db.orders.get`, `db.orders.save` | The model's read and write points. A step can only pass the sync gate it names |
| `transparent` | `db.transaction`, `stripe.refunds.create` | Intermediate points. A step on its way to another gate passes them automatically, but a step can also name one explicitly to stop there. They still serialise workers and appear in the gate log |

**Step `[w, G]` means "pass through G".** Exact semantics:

1. If `w` is `new` or `ready`, resume it and wait until it stops running.
2. If `w` is parked at a transparent gate other than `G`, pass that gate (the call executes) and go
   back to 2.
3. If `w` is parked at `G`, pass `G`: the call executes now. Then wait until `w` stops running
   again, which is normally parked at its *next* gate. The step is done.
4. Anything else is a divergence (table below).

So a worker *arrives* at a gate at the end of its previous step. Arriving is a state, not a step.
The call's effect happens when the gate is passed, not when it is reached: a read returns the store
contents at pass time. This makes `[w1, get], [w2, get]` mean "both reads happen before either
write", which is the model's read/read.

**`[w, "until-done"]`** passes every gate (sync or transparent) until `fn` settles. A throw is a
valid outcome here, not a divergence; check `s.outcome(w)`. If `w` is `waiting`, the step
diverges with `blocked`.

**Transactions.** `db.transaction` is a transparent gate. Passing it requests the transaction lock
(a `SchedLock`, one per store per run).
- If the lock is free, the worker takes it and keeps running into the callback.
- If the lock is held, the worker becomes **`waiting`**. The step is over: the worker is not
  "arrived at a gate", and nothing can resume it.
- When the holder commits (staged writes are applied, then the lock is released in `finally`, all
  inside the holder's own step), the lock passes FIFO to the next waiter. That worker becomes
  **`ready`**. It does **not** run until a step or `drain` resumes it, so the mutex never runs a
  second worker behind the schedule's back.
- A step aimed at a `waiting` worker fails with `blocked` and names the holder. A wait-for cycle,
  such as a nested transaction on the same store, fails with `deadlock`.

**`drain()`** runs every unfinished worker to completion in a fixed order: it repeatedly resumes
the first resumable worker in spawn order. If only `waiting` workers remain, it throws `deadlock`.

**`reset()`** starts a new generation. It discards workers, locks and logs, empties the fake stores
and resets the fake id counters. A late call from an older generation is a `stray-gate`.

### Divergences

`play` throws `ReplayDivergence` and `tryPlay` returns it. Each one carries `details` (kind, step
index, worker, expected, actual, a snapshot of every worker, the steps completed so far) and a
message like this:

```
Replay diverged at step 2/6 ["w2", "db.orders.get"]: blocked
  w2 is waiting for "db.transaction" held by w1 (parked at "db.orders.save") and cannot reach "db.orders.get" until w1 releases it. The code serialises these workers more strictly than the schedule assumes.
Workers:
  w1  parked at "db.orders.save"   passed: db.transaction → db.orders.get
  w2  waiting for "db.transaction" (held by w1)   passed: db.transaction
Completed steps:
  1. ["w1", "db.orders.get"]
```

| Kind | When |
|---|---|
| `invalid-schedule` | Unknown worker, or a gate no instrument defines (typo). Checked before anything runs, and the message lists the known gates |
| `finished-early` | The worker returned without reaching the named gate (e.g. the code backs out because it saw `refunded`) |
| `threw` | The worker threw before reaching the named gate. `details.cause` holds the error |
| `different-gate` | The worker's next sync gate isn't the one named |
| `blocked` | The worker is `waiting` for a resource held by another worker |
| `deadlock` | A wait-for cycle, or `drain` with only waiting workers left |
| `timeout` | The resumed worker neither parked nor settled within `stepTimeoutMs` (default 2000). It is awaiting something the scheduler doesn't control |
| `stray-gate` | A worker called a gate while it wasn't the running worker: `Promise.all` over gated calls, fire-and-forget work, or a callback that outlived its step. The stray call is never let through |

### When the code is safer than the trace (`replay-disagrees`)

The B3 schedule, unchanged, against `refund-fixed`: w1 passes `db.transaction` (takes the lock) and
reads. Then w2 is sent towards its read, passes `db.transaction` and waits. The replay diverges at
step 2 with `blocked`. A generated test should then:

1. `tryPlay(schedule)` and keep the divergence,
2. `drain()` so every worker finishes in a fixed order,
3. evaluate the violated property against the real outcome (here `stripe.refunds.create` count ≤ 1),
4. map the result with `replayVerdict`:

| Followed? | Property violated? | Verdict | Report |
|---|---|---|---|
| yes | yes | `confirmed` | Implementation bug confirmed: the test fails |
| no | yes | `confirmed-divergent` | Bug confirmed through a different interleaving: fail, and attach the divergence |
| no | no | `replay-disagrees` | The code is safer than the trace (e.g. `blocked` by a lock). Warning with the divergence attached |
| yes | no | `replay-disagrees` | The schedule was followed but the effect never happened: a mapping or instrumentation gap. Warning |

For the fixed code, both the hand-written schedule and the one generated from the trace come out
`replay-disagrees` / `blocked` / 1 refund in 100/100 runs. The *adapted* schedule
(`b3-fixed.test.ts`: `[w1,get] [w2,db.transaction] [w1,save] [w2,get] …`) is the closest legal
interleaving to read/read. It is followed exactly, and w2 reads `refunded` and backs out.

## API sketch for `@tsverify/runtime`

```ts
// Scheduler
export function scheduler(opts?: { stepTimeoutMs?: number }): Scheduler;
export const UNTIL_DONE = "until-done";
export type Step = readonly [worker: string, target: string]; // gate label | "until-done"
export type Schedule = readonly Step[];

interface Scheduler {
  spawn(id: string, fn: () => unknown): void;           // lazy start
  play(schedule: Schedule): Promise<PlayReport>;        // throws ReplayDivergence
  tryPlay(schedule: Schedule): Promise<{ followed: true; report: PlayReport } | { followed: false; divergence: ReplayDivergence }>;
  drain(): Promise<void>;                               // fixed-order completion; throws `deadlock`
  reset(): void;                                        // new generation; fakes emptied
  outcome(id: string): { status: "done"; value } | { status: "failed"; error } | { status: "unfinished"; state };
  effects(label?: string): EffectCall[];                // { seq, worker, effect, args }
  gateLog(): GateEvent[];                               // { seq, worker, gate, args } in pass order
  snapshot(): WorkerSnapshot[];

  // used by instruments, not by tests
  defineGate(label: string, kind: "sync" | "transparent"): void;
  gate(label: string, args: readonly unknown[]): Promise<void>;
  lock(name: string): SchedLock;                        // reports waiting/ready to the scheduler
  recordEffect(label: string, args: readonly unknown[]): void;
  onReset(hook: () => void): void;
  currentWorker(): Worker | undefined;
}

// Fakes: `client` is what the vi.mock factory exports; the rest is test-side and ungated
export const instrument: {
  store(s, { name: "db", collections: { orders: { key: "id" } } }): { client; seed(c, rows); rows(c) };
  effects(s, { name: "stripe", calls: ["refunds.create"], returns?, gate? }): { client };
  // M9: prisma(s, …) / drizzle(s, …): same gate model, client-specific API surface
};

// Trace → schedule
export function planFromTrace(trace: Trace, mapping: ReplayMapping): TraceReplayPlan;
//   ReplayMapping   = { transitions: { [t]: { read?, write?, atomic?: gate[] } }, effects: { [modelEffect]: gate } }
//   TraceReplayPlan = { property, startIndex, seedStatus, workers, schedule, origins, expectedEffects }
export function replayVerdict(r: { followed: boolean; violated: boolean }): "confirmed" | "confirmed-divergent" | "replay-disagrees";
export class ReplayDivergence extends Error { details: DivergenceDetails; kind: DivergenceKind }
```

Gate labels are **client call paths** (`<client>.<path>`), the same path the extractor sees in
source and that `Bindings.effects` already uses (`stripe.refund` → `stripe.refunds.create`).
Calls inside a transaction use the same labels as calls outside it.

## How `vi.mock` is wired

```ts
import { vi } from "vitest";
import { instrument, scheduler } from "@tsverify/runtime";

const s = scheduler();                                   // (1) plain top-level consts
const db = instrument.store(s, { name: "db", collections: { orders: { key: "id" } } });
const stripe = instrument.effects(s, { name: "stripe", calls: ["refunds.create"] });

vi.mock("../app/db", () => ({ db: db.client }));         // (2) hoisted, factory runs lazily
vi.mock("../app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("../app/refund-buggy"); // (3) dynamic import, after (1)
```

- **ESM hoisting.** Vitest moves every `vi.mock` call above all imports, and rewrites the file's
  static imports into awaited dynamic imports placed after the mocks. The factory runs **lazily**,
  the first time the mocked module is imported. The code under test must therefore be imported
  **dynamically, after** the fakes exist (3). With a static `import { refundOrder } from
  "../app/refund-buggy"` the factory runs before `const db = …` has been initialised, and vitest
  fails with `ReferenceError: Cannot access 'db' before initialization` ("There was an error when
  mocking a module…"). This was checked with vitest 4.1.12 during the spike. `vi.hoisted` is the
  alternative, but it can't use static imports, so it would need `await import("@tsverify/runtime")`
  inside. Plain consts plus a dynamic import of the code under test is simpler to generate.
- **Which modules.** Mock the module *where the client is defined* (`app/db.ts`), with the path
  resolved relative to the test file. Every importer of that module, at any depth, gets the fake,
  so the app needs no changes. Modules that aren't mocked (`app/audit.ts`) run for real.
- **One fake per file, reset per run.** The fakes are module-level and shared by all tests in the
  file, so each run starts with `s.reset()` and then `db.seed(...)`. Vitest isolates test files, so
  each file has its own scheduler.
- **One runtime instance.** The `AsyncLocalStorage` instance lives in the runtime module. The test
  and the mock factories must load the same copy of `@tsverify/runtime`. `tsverify test` should bundle it once
  and not let the target project resolve its own copy.

## Results

| Test | Runs | Result |
|---|---|---|
| B3 model-shaped schedule (`get, get, save, save`) vs `refund-buggy` | 100 | Stripe ×2 in 100/100, fingerprints identical 100/100 |
| B3 explicit schedule (every gate, including `stripe.refunds.create`) vs `refund-buggy` | 100 | Identical to the model-shaped run 100/100 |
| B3 adapted schedule vs `refund-fixed` | 100 | Followed, Stripe ×1 in 100/100, fingerprints identical |
| B3 unadapted vs `refund-fixed`: `tryPlay` + `drain` | 100 | `blocked` at step 2, Stripe ×1, the same single verdict 100/100 |
| Golden `b6-refund-race` trace vs `refund-buggy` | 100 | `confirmed`, 2 refunds = the model's predicted delta, 100/100 identical |
| Golden `b6-refund-race` trace vs `refund-fixed` | 100 | `replay-disagrees` (`blocked`), 1 refund, 100/100 identical |

The whole suite (26 tests, about 600 replays) also ran **10 times back to back with 10/10 green**
on the shared 2-CPU machine. One replay of the refund race takes about 1 ms.

## Limits

- **Timers.** A real `setTimeout` or `setImmediate` *inside the running worker* is fine: the step
  just waits until the worker parks. The problem is a timer that fires *while the worker is
  parked* (a `Promise.race` timeout, retry/backoff, debounce, a background flush). Its callback
  runs outside the schedule. If it reaches a gate, the replay fails with `stray-gate`. If it only
  touches ungated state, the replay can't see it. **Fake timers** (`vi.useFakeTimers`) make a
  worker that awaits one never park, which ends in `timeout`. Generated tests must not enable
  them. A later version could add an "advance clock" step.
- **`process.nextTick` / `queueMicrotask` / event emitters.** These are fine while they belong to
  the running worker. The same stray rules apply when the work outlives the step.
- **Real I/O.** Ungated I/O (fs, `fetch`, a client that wasn't mocked, a real DB) runs inside the
  step and only slows it down. But the shared state behind it is not ordered by the schedule, and
  a hang shows up as a `timeout`. D7 holds here: every client that touches shared state must be
  replaced by a fake.
- **`worker_threads` / child processes.** `AsyncLocalStorage` doesn't cross threads or processes,
  and gates there can't reach the scheduler. Out of scope.
- **Client references captured before mocking.** If the code under test is loaded before the mock
  is registered (a `setupFiles` entry that imports the app, a static import in the generated test,
  a module that another test file has already cached when isolation is off), or if the app builds
  its own client (`new PrismaClient()` inside a module that wasn't mocked), the real client is
  used and no gates fire. The first step then fails with `finished-early` / `timeout`, so the
  failure isn't silent, but the replay doesn't run either. Mock the module that *constructs* the
  client. Destructuring the mocked export at module top level (`const { orders } = db`) is fine,
  because it destructures the fake.
- **Concurrency inside one worker.** `Promise.all([db.get(a), db.get(b)])` fails with `stray-gate`.
  Supporting it would need sub-worker ids (e.g. `w1/0`, `w1/1`) and a step per branch.
- **Ungated shared state.** Only instrumented clients are ordered. Module-level caches or maps in
  app code that two workers both touch race freely inside steps. Steps are atomic with respect to
  each other, so the result is still deterministic, but it may not be the interleaving the model
  meant.
- **Lock model.** The fake transaction is one serialisable mutex per store. Real isolation levels
  are weaker (READ COMMITTED without `FOR UPDATE`, or a conditional `updateMany` as the atomic
  primitive), so each adapter fake (M9) must model the semantics of the calls the code actually
  makes. Otherwise the replay is "safer than production" and reports a false `replay-disagrees`.
- **Prefix fast-forward.** `planFromTrace` replaces leading actions on transitions it doesn't
  replay (checkout, payment) with a seed of the entity status and an effect baseline. That is
  sound only if nothing is in flight at that point (this is checked) and if `status` is all of the
  model state. Every other field must come from a fixture.
- **Repeated gates.** If a path calls `db.orders.get` twice, consecutive steps refer to successive
  occurrences. The mapping must emit one step per occurrence.

## What testgen (M6) must emit

For each counterexample, write one file in `.tsverify/generated/` that contains:

1. Top-level `const s = scheduler()`, plus one `instrument.<kind>(s, …)` fake per entry in
   `bindings.clients`.
2. `vi.mock("<client module, relative to the generated file>", () => ({ <export>: fake.client }))`
   for each client.
3. `await import("<impl module>")` for each `Transition.impl` involved. It **must** be dynamic and
   come after (1).
4. A seed: the entity row with `status = plan.seedStatus` plus the fixture fields the code needs
   (id, `chargeId`, `amount`…). These come from a spec example or a fixture factory, not from the
   trace.
5. `s.spawn(traceWorkerId, () => impl(entityId, actor?))` for each trace worker. The ids come from
   the trace (`refund#1`) so messages line up with the playback view.
6. The schedule as a **literal** with a comment per step pointing to the trace step (`origins`).
   That keeps the generated file readable without the runtime. `planFromTrace` can do the
   expansion at generation time.
7. `tryPlay`, then `drain`, then evaluate the violated property in code terms (effect counts from
   `s.effects(label)`, final status from `fake.rows(...)`), then `replayVerdict`. Assert so that
   `confirmed` / `confirmed-divergent` **fail** the test. Write the verdict and divergence details
   to a JSON sidecar so `tsverify` can report `replay-disagrees` as a warning.
8. No fake timers and no `setupFiles` that import app code. Use one run per test: the replay is
   deterministic, and repeating it only checks for flakiness.

## What `CodeSites` must contain

Today `Transition.sites` holds only source locations (`read`, `write`, `guards`, `effects`). Replay
also needs the *call path* of each site and how to invoke the impl. Proposed extension:

```ts
interface CodeSites {
  read?: CallSite;               // e.g. { client: "db", path: "orders.get", at, ordinal: 0 }
  write?: CallSite;              // e.g. { client: "db", path: "orders.save", at }
  guards?: { guard: string; at: SourceLocation }[];
  effects?: (CallSite & { effect: string; beforeWrite: boolean })[];   // stripe.refunds.create
  /** Present when read/write sit inside a transaction or lock: lets the planner expect `blocked`. */
  atomicity?: { kind: "transaction" | "conditional-update" | "none"; site?: CallSite };
}
interface CallSite {
  client: string;                // key into Bindings.clients → module + export to vi.mock
  path: string;                  // call path below the client → gate label `${client}.${path}`
  at: SourceLocation;
  ordinal?: number;              // which occurrence on the path, if the same call repeats
}
// Transition-level, for invoking the impl:
interface ImplCall {
  module: string; symbol: string;            // already in Transition.impl
  entityParam: number | string;              // which parameter (or field) carries the entity id
  actorParam?: number | string;              // where the actor/context goes, if any
}
// Entity-level, for seeding and reading back:
//   collection (`orders`), key field (`id`), state field (EntityDecl.stateField).
```

From these, the planner derives `ReplayMapping` mechanically: `read` → `[${client}.${path}]`,
`write` → likewise, `atomic` → the transaction gate followed by read and write, and effects from
`Bindings.effects`. `Bindings.clients` already gives module + export. It also needs the client
kind (repository / Prisma / Drizzle) to choose the fake.

## Go / no-go

**Go** for counterexample replay in M6, with these caveats:
- Determinism comes from "one worker runs at a time, and a step ends on an event". It doesn't
  depend on timing, so it held at 100/100 everywhere in the spike, including with microtask and
  macrotask noise in the app.
- It only holds when every client that touches shared state is faked and gated, and the code under
  test doesn't run concurrent gated calls inside one invocation. Both failures are loud
  (`timeout`, `stray-gate`, `finished-early`), not silent.
- The adapter fakes (M9) carry most of the remaining risk: their lock and conditional-write
  semantics decide whether `replay-disagrees` means "the code is safer" or "the fake is too
  strong".
