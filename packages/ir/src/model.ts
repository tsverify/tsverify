import type { Rule } from "./expr";
import type { SourceLocation } from "./location";

/** A reference to a code symbol, written `path/to/file.ts#symbolName` in YAML. */
export interface SymbolRef {
  file: string;
  symbol: string;
}

/** A guard reference, written `owner` or `role(admin)` in YAML. */
export interface GuardRef {
  name: string;
  args: string[];
  /** Canonical text form, e.g. `role(admin)`. Used as the key into `Bindings.guards`. */
  raw: string;
  /** Where the guard is written in the spec (a `requires` item). */
  at?: SourceLocation;
}

export type Trust = "untrusted" | "authenticated" | "signed-webhook" | "internal";

export interface Actor {
  name: string;
  trust: Trust;
  /** Guards implied for every transition this actor performs. */
  requires: GuardRef[];
  at?: SourceLocation;
}

export type EffectMultiplicity = "exactly-once" | "at-least-once" | "idempotent";

export interface EffectDecl {
  /** Effect name as written in the spec, e.g. `stripe.refund`. See `Bindings.effects`. */
  name: string;
  multiplicity: EffectMultiplicity;
  at?: SourceLocation;
}

/**
 * A call on a bound client (see `Bindings.clients`), e.g. `tx.orders.get(id)` on client `db`.
 * `gate` is the label replay uses to pause a worker at this call.
 *
 * A call to a named storage function (`Bindings.storage`) is a call site with `client: "storage"`,
 * `path: <symbol>` and `gate: "storage.<symbol>"`, e.g. `getOrder(id)` → `storage.getOrder`.
 */
export interface CallSite {
  at: SourceLocation;
  /** Client binding name, e.g. `db`, `stripe`. */
  client: string;
  /**
   * Member path below the client export, e.g. `orders.get`, `refunds.create`. Empty when the
   * client export is itself a function called directly (`sendMail(…)` on client `email`).
   */
  path: string;
  /** `${client}.${path}`, e.g. `db.orders.get`; just `${client}` when `path` is empty. */
  gate: string;
  /** 0-based occurrence of `gate` within one invocation of the impl (repeated calls). */
  occurrence: number;
}

/**
 * The construct that makes a transition's state check and write indivisible.
 *
 * With named storage functions (`Bindings.storage`), a conditional save (`storage.update`) is
 * `{ kind: "conditional-update", gate: "storage.<symbol>" }`, and a read and write inside a
 * named atomic function (`storage.atomic`) is `{ kind: "declared", gate: "storage.<symbol>" }`.
 */
export interface AtomicScope {
  /**
   * - `synchronous`: `memory` persistence, no `await`/`yield` between the check and the write.
   * - `declared`: the transition runs inside a named `storage.atomic` function. It is atomic
   *   because the spec declares that function atomic, not because tsverify proved it.
   */
  kind: "transaction" | "conditional-update" | "lock" | "synchronous" | "declared";
  at: SourceLocation;
  /** Gate of the call that opens the scope, e.g. `db.transaction`, `storage.withTransaction`. */
  gate?: string;
}

/** Where an invocation argument comes from: parameter index plus an optional property path. */
export interface ArgPath {
  param: number;
  /** e.g. `["orderId"]` for `event.orderId`, `["actor"]` for `ctx.actor`. Empty = the parameter itself. */
  path: string[];
}

/** How generated tests call an impl (derived from the impl's signature and data flow). */
export interface InvocationShape {
  impl: SymbolRef;
  /** Which argument carries the entity id. */
  entityId: ArgPath;
  /** Which argument carries the actor, when the impl takes one. */
  actor?: ArgPath;
}

/** Narrowed from-state at the write, as computed by the type checker. */
export interface FromState {
  /** Literal states the entity can be in just before the write, or `"*"` when unknown. */
  values: string[] | "*";
  /** true when the narrowed type is the full declared union (no guard constrains the write). */
  unconstrained: boolean;
  /** Present when `values` is `"*"` or unconstrained, e.g. `status is typed string`. */
  reason?: string;
}

/**
 * Code facts for one extracted transition (only present when `origin: "code"`).
 * One `Transition` in a code model corresponds to one state write in the code.
 */
export interface CodeSites {
  /** `functions` when the entity is read and saved through named storage functions. */
  persistence: PersistenceKind;
  /** The state write itself (assignment, spread property, or update call). */
  write: SourceLocation;
  /** Function containing the write (may be a helper called by the impl). */
  function: { file: string; name: string; at: SourceLocation };
  /** Name of the spec transition whose `impl` reaches this write; absent for unlinked writes. */
  specTransition?: string;
  fromState: FromState;
  /** The read that produced the entity the write checks (e.g. `db.orders.get`). */
  read?: CallSite;
  /** The persistence call that commits the write (e.g. `db.orders.save`). */
  commit?: CallSite;
  atomic?: AtomicScope;
  /**
   * Why the read and write are not atomic although they look scoped, when the adapter can say
   * (e.g. an interactive Prisma `$transaction` at READ COMMITTED). Conformance uses it as the
   * reason and hint of the `non-atomic` finding.
   */
  atomicNote?: { message: string; hint: string; at: SourceLocation };
  /** Bound guards called on some path to the write; `dominates` = called on every path. */
  guards: { guard: string; at: SourceLocation; dominates: boolean }[];
  /**
   * The distinct sets of bound guard keys passed on the paths from the impl's entry to the write
   * (across helper calls). Each set sorted, the list sorted and deduplicated, e.g.
   * `[["owner"], ["role(admin)"]]` for `if (isAdminUser) requireRole(…) else requireOwner(…)`.
   * `[[]]` means some path passes no guard. Absent when the extractor could not enumerate them
   * (too many combinations); conformance then falls back to `guards[].dominates`. Used for
   * `by: [a, b]`, where each listed actor is an alternative: every set must contain the
   * transition's own `requires` plus all of some listed actor's `requires`.
   */
  guardSets?: string[][];
  /** Effect calls attributed to this transition. `effect` is the spec effect name, or the gate when unmapped. */
  effects: (CallSite & { effect: string })[];
  invocation?: InvocationShape;
  /**
   * Where the entity is stored, for seeding and reading back in generated tests. With named
   * storage functions: `{ client: "storage", collection: <entity name>, key: <StorageBinding.key> }`.
   */
  storage?: { client: string; collection: string; key: string };
}

export interface Transition {
  name: string;
  /** Allowed source states; `"*"` means unconstrained (any state). */
  from: string[] | "*";
  to: string;
  by: string[];
  requires: GuardRef[];
  effects: EffectDecl[];
  /** true: the state check and the write happen as one indivisible step. */
  atomic: boolean;
  /** true: the triggering event may be delivered more than once (e.g. webhooks). */
  idempotent: boolean;
  /** Informational timer, e.g. `30m`. Modelled as an always-possible system action. */
  after?: string;
  impl?: SymbolRef;
  at?: SourceLocation;
  /** Spec locations of each `from` item (aligned with `from` when it is a list). */
  fromAt?: SourceLocation[];
  /** Spec locations of each `by` item (aligned with `by`). */
  byAt?: SourceLocation[];
  sites?: CodeSites;
}

export interface EntityDecl {
  name: string;
  /** Name of the field in code that holds the state, e.g. `status`. */
  stateField: string;
  states: string[];
  initial: string;
  terminal: string[];
  at?: SourceLocation;
}

/**
 * - `assign`: repository fakes (`db.orders.get/save`, `db.transaction`) with plain assignment
 * - `prisma` / `drizzle`: ORM calls (M9+)
 * - `memory`: in-process objects with no client; atomic = no `await`/`yield` between check and write
 * - `functions`: the app's own storage functions, named in `Bindings.storage`. Only code models
 *   use it (`CodeSites.persistence`); a spec's `Bindings.persistence` holds a preset.
 */
export type PersistenceKind = "assign" | "prisma" | "drizzle" | "memory" | "functions";

export interface ClientBinding {
  module: string;
  export: string;
  at?: SourceLocation;
}

/** `src/auth/guards.ts#requireRole("admin")` → file, symbol `requireRole`, args `["admin"]`. */
export interface GuardBinding {
  file: string;
  symbol: string;
  args: string[];
  raw: string;
  at?: SourceLocation;
}

/**
 * What one positional argument of a storage function carries:
 * - `key`: the entity's key (`StorageBinding.key`)
 * - `entity`: a whole entity
 * - `patch`: some fields of an entity, merged into the stored one
 * - `from`: the state, or list of states, a conditional save requires
 * - `to`: the state a conditional save sets
 * - `callback`: the function an atomic function runs
 * - `_`: an argument tsverify ignores
 */
export type StorageRole = "key" | "entity" | "patch" | "from" | "to" | "callback" | "_";

/**
 * One storage function of the app, written `path#symbol` or `{ fn, args, returns?, from?, to? }`.
 * Default `args`: read `[key]`, save `[entity]`, update `[key, from, to]` minus the roles a fixed
 * `from` / `to` replaces, atomic `[callback]`.
 */
export interface StorageFunction {
  ref: SymbolRef;
  /** Role of each positional argument. */
  args: StorageRole[];
  /**
   * Update only: what the conditional save returns (default `changed`). On success / when the
   * state check fails: `changed` → `true` / `false`; `count` → `1` / `0`; `entity` → the updated
   * entity / `undefined`; `throws` → nothing useful / it throws.
   */
  returns?: "changed" | "count" | "entity" | "throws";
  /** Update only: the fixed from-states, when no argument has the `from` role. */
  from?: string[];
  /** Update only: the fixed target state, when no argument has the `to` role. */
  to?: string;
  at?: SourceLocation;
}

/**
 * `bindings.storage` in its named-function form: the app's own functions that read, save,
 * conditionally save and atomically run code for the entity. tsverify treats them as the storage
 * boundary and does not look inside them. Each list is in YAML order.
 *
 * Conventions for code models:
 * - a call to one of them is a `CallSite` with `client: "storage"`, `path: <symbol>` and
 *   `gate: "storage.<symbol>"`
 * - code sites use `persistence: "functions"` and
 *   `storage: { client: "storage", collection: <entity name>, key }`
 * - a conditional save's `CodeSites.atomic` is `{ kind: "conditional-update", gate }`; running
 *   inside an `atomic` function is `{ kind: "declared", gate }`
 */
export interface StorageBinding {
  /** The entity's key field (default `id`). */
  key: string;
  /** Load one entity by key. */
  read: StorageFunction[];
  /** Persist an entity. */
  save: StorageFunction[];
  /** Conditional save: checks the state and saves in one step. */
  update: StorageFunction[];
  /** Run a callback as one indivisible step (declared, not proven). */
  atomic: StorageFunction[];
  at?: SourceLocation;
}

export interface Bindings {
  /**
   * The preset storage style: `bindings.storage: assign | prisma | memory`, or its alias
   * `bindings.persistence`. Omitted → auto-detected by the extractor from imports (unless
   * `storage` names the app's own functions).
   */
  persistence?: PersistenceKind;
  /** `bindings.storage` in its named-function form; absent for a preset. */
  storage?: StorageBinding;
  clients: Record<string, ClientBinding>;
  /** Keyed by `GuardRef.raw`, e.g. `role(admin)`. */
  guards: Record<string, GuardBinding>;
  /** Effect name → code call path, e.g. `stripe.refund` → `stripe.refunds.create`. Omitted → name is the path. */
  effects: Record<string, string>;
  /** Spec location of each `effects` entry, keyed like `effects`. */
  effectsAt?: Record<string, SourceLocation>;
}

/**
 * - `spec`: parsed from a behavior file.
 * - `code`: the as-implemented model built by the extractor. It copies the spec's name, entity, actors,
 *   rules, bindings and file; only `transitions` (one per state write, with `sites`) and `concurrency`
 *   come from the code. Conventions:
 *   - a write reached from spec transition `t`'s impl is named `t` when it writes `t.to`, otherwise
 *     `t->to`; an unlinked write is named after its function; collisions get `~2`, `~3`, …
 *   - `by`, `idempotent` come from the linked spec transition (`[]` / `false` when unlinked)
 *   - `requires` = bound guards that dominate the write; `atomic` = read and write share one scope
 *   - effect multiplicity comes from the spec declaration of that effect (`at-least-once` if undeclared)
 *   - `concurrency` copies the linked spec transition's bound (2 when unlinked)
 *   - spec transitions without `impl` are copied unchanged and without `sites` (assumed to behave
 *     as specified), so the code model stays complete; conformance skips them
 */
/**
 * Values generated tests use to drive the real code. Opaque JSON, passed through verbatim, except
 * that the strings `"$id"` and `"$actor"` inside `args` are replaced by the seeded entity's key and
 * the acting actor's fixture.
 */
export interface Fixtures {
  /** Fields of a seeded entity, apart from the state field (which each test sets). */
  entity: Record<string, unknown>;
  /** Value per spec actor name, passed where the impl takes an actor (`InvocationShape.actor`). */
  actors: Record<string, unknown>;
  /** Per-transition argument list, overriding the default built from `InvocationShape`. */
  args: Record<string, unknown[]>;
  at?: SourceLocation;
}

export type ModelOrigin = "spec" | "code";

export interface BehaviorModel {
  kind: "entity";
  name: string;
  summary?: string;
  /**
   * The spec's `enforced: true`: the team marked it as one CI should block on. `tsverify` never acts
   * on it by itself (CI decides policy); it is carried into `--format json|sarif` and selectable with
   * `--enforced-only`, so a pipeline can block on enforced specs and stay advisory elsewhere.
   */
  enforced?: boolean;
  origin: ModelOrigin;
  /** Path of the behavior file this model came from (relative to the project root). */
  file?: string;
  entity: EntityDecl;
  /** Keyed by actor name. */
  actors: Record<string, Actor>;
  /** Sorted by name. */
  transitions: Transition[];
  rules: Rule[];
  /**
   * Number of independent invocations explored per transition (each may interleave with the
   * others). Fully resolved: every transition has an entry.
   */
  concurrency: Record<string, number>;
  bindings: Bindings;
  /** Test fixtures for generated tests (spec models only; optional). */
  fixtures?: Fixtures;
  /** Code models only: declaration location of each linked spec transition's `impl`, keyed by transition name. */
  implAt?: Record<string, SourceLocation>;
  /**
   * Code models only: state writes the extractor saw but could not read as a transition (a value
   * that is not a literal, a patch object built up before it is saved, …), reached from a spec
   * transition's `impl`, keyed by transition name. Each is already an `unanalyzable` finding
   * (`finding` is its id). Conformance reports a transition with no readable write but one of
   * these as unconfirmed (`unanalyzable`) instead of `missing-transition`.
   */
  unreadWrites?: Record<string, UnreadWrite[]>;
}

/** A state write the extractor could not read as a transition (`BehaviorModel.unreadWrites`). */
export interface UnreadWrite {
  at: SourceLocation;
  /** The function the write is in. */
  function: string;
  /** Why it can't be read, in a few words, e.g. "the value `input.status` is not a single literal". */
  reason: string;
  /** The written state, when it is a literal (the write is unreadable for another reason). */
  value?: string;
  /** Id of the extractor's `unanalyzable` finding for the write. */
  finding: string;
}
