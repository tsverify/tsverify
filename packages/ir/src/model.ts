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

/** Code call sites recovered by the extractor (only present when `origin: "code"`). */
export interface CodeSites {
  read?: SourceLocation;
  write?: SourceLocation;
  guards?: { guard: string; at: SourceLocation }[];
  effects?: { effect: string; at: SourceLocation }[];
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
