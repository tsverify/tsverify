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
 */
export interface CallSite {
  at: SourceLocation;
  /** Client binding name, e.g. `db`, `stripe`. */
  client: string;
  /** Member path below the client export, e.g. `orders.get`, `refunds.create`. */
  path: string;
  /** `${client}.${path}`, e.g. `db.orders.get`. */
  gate: string;
  /** 0-based occurrence of `gate` within one invocation of the impl (repeated calls). */
  occurrence: number;
}

/** The construct that makes a transition's state check and write indivisible. */
export interface AtomicScope {
  kind: "transaction" | "conditional-update" | "lock";
  at: SourceLocation;
  /** Gate of the call that opens the scope, e.g. `db.transaction`. */
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
  /** Bound guards called on some path to the write; `dominates` = called on every path. */
  guards: { guard: string; at: SourceLocation; dominates: boolean }[];
  /** Effect calls attributed to this transition. `effect` is the spec effect name, or the gate when unmapped. */
  effects: (CallSite & { effect: string })[];
  invocation?: InvocationShape;
  /** Where the entity is stored, for seeding and reading back in generated tests. */
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

export type PersistenceKind = "assign" | "prisma" | "drizzle";

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

export interface Bindings {
  /** Omitted → auto-detected by the extractor from imports. */
  persistence?: PersistenceKind;
  clients: Record<string, ClientBinding>;
  /** Keyed by `GuardRef.raw`, e.g. `role(admin)`. */
  guards: Record<string, GuardBinding>;
  /** Effect name → code call path, e.g. `stripe.refund` → `stripe.refunds.create`. Omitted → name is the path. */
  effects: Record<string, string>;
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
 */
export type ModelOrigin = "spec" | "code";

export interface BehaviorModel {
  kind: "entity";
  name: string;
  summary?: string;
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
}
