/**
 * A persistence adapter knows one ORM / data-access style: how a transition reads the entity, how
 * it commits the write, and which construct makes the two atomic.
 */
import type { AtomicScope, EntityDecl, FromState, PersistenceKind } from "@tsverify/ir";
import type { Callees, Reach } from "../callgraph";
import type { FunctionLike } from "../cfg";
import type { ClientCall, ClientCalls, ScopeRef } from "../client-calls";
import type * as TS from "../ts-types";
import type { WriteKind, WriteNode } from "../writes";

/** Context for a "not atomic" verdict: becomes `CodeSites.atomicNote` (the reason in `non-atomic`). */
export interface AtomicityNote {
  /** Short kind, e.g. `isolation-level` (for tests and debugging). */
  subject: string;
  message: string;
  hint: string;
  /** Where the note points (e.g. the `$transaction` call). */
  at: TS.Node;
}

export interface PersistenceFacts {
  /** The client call whose result is the entity reference the write checks. */
  read?: ClientCall;
  /** The client call that persists the write. */
  commit?: ClientCall;
  /**
   * The call whose result the code checked the state on before an unconditional update (a bound
   * read, or a list read): the update is atomic only when this call and the update share one
   * atomic scope (`functions`; see "Checks before an unconditional update").
   */
  checkedRead?: TS.CallExpression;
  /** The scope read and write share, when they do (and it makes them atomic). */
  scope?: ScopeRef;
  /** Read and write (and commit) run inside one atomic scope. */
  atomic: boolean;
  /**
   * The atomic construct when it is not a shared callback scope, e.g. a conditional update:
   * recorded as `CodeSites.atomic` at `call`. Takes precedence over `scope`.
   */
  atomicAt?: { kind: AtomicScope["kind"]; call: TS.CallExpression; gate: string };
  /** The from-state when the persistence call itself decides it (an update's `where`). */
  fromState?: FromState;
  /**
   * When `fromState.values` is `*`: what to do about it, for the hint of the `unanalyzable`
   * from-state finding (default: restructure the check, docs/authoring-guide.md §7.5).
   */
  fromStateHint?: string;
  storage?: { client: string; collection: string; key: string };
  /**
   * The expression carrying the entity's id, when there is no read call whose first argument
   * carries it (`workerId` in `this.workers.get(workerId)`, `orderId` in `where: { id: orderId }`).
   * Traced to the impl's parameters for `InvocationShape.entityId`.
   */
  entityKey?: TS.Expression;
  /**
   * Why atomicity could not be determined. Each becomes an `unanalyzable` warning when the linked
   * spec transition is `atomic: true` (otherwise the answer does not matter).
   */
  problems: string[];
  /** Why the write is not atomic although it looks scoped; the first becomes `CodeSites.atomicNote`. */
  notes?: AtomicityNote[];
  /**
   * The write is not read or saved through the storage the spec names (a call into an unbound
   * data layer): always an `unanalyzable` warning, whatever the spec's `atomic`.
   */
  unbound?: { message: string; hint: string };
  /**
   * The write sets the entity's state in a form tsverify can't read as a transition (a patch
   * object built up before it is saved, a field set on it afterwards): it is not extracted, and
   * becomes an `unanalyzable` warning. `reason` is the short form, for the transitions it leaves
   * unconfirmed (`BehaviorModel.unreadWrites`).
   */
  unreadable?: { message: string; reason: string; hint: string };
}

export interface AdapterInput {
  write: WriteNode;
  /** The function frame containing the write (with its inline callbacks). */
  frame: FunctionLike;
  /** Calls in `frame`, in source order. */
  frameCalls: readonly TS.CallExpression[];
  calls: ClientCalls;
  callees: Callees;
  checker: TS.Checker;
  /** The spec's entity. */
  entity: EntityDecl;
}

/** One write as reached from one impl (or, unlinked, from its own frame). */
export interface LinkInput {
  write: WriteNode;
  frame: FunctionLike;
  reach: Reach;
  checker: TS.Checker;
  /** The adapter's facts for the write (`analyzeWrite`). */
  facts: PersistenceFacts;
}

/** Atomicity that depends on the path from the impl to the write. */
export interface LinkAtomicity {
  atomic: boolean;
  /** The scope kind recorded in `CodeSites.atomic` (at the write) when atomic. */
  kind?: AtomicScope["kind"];
  /** The call that opens the scope, when it is not the write (`CodeSites.atomic.at`). */
  at?: TS.Node;
  /** The gate of `at`'s call. */
  gate?: string;
  /**
   * Facts that depend on the call path too (a read or commit in the impl, for a write in a
   * helper that takes the entity as a parameter): they replace `analyzeWrite`'s for this link.
   */
  facts?: Partial<Pick<PersistenceFacts, "read" | "commit" | "entityKey" | "problems" | "unbound">>;
}

/** An effect call attributed to a write, as `effectCalls` found it. */
export interface EffectInput {
  call: ClientCall;
  write: WriteNode;
  frame: FunctionLike;
  reach: Reach;
  checker: TS.Checker;
}

/**
 * - `attributed`: it runs on the write's path (the default for every effect);
 * - `excluded`: it runs only when the write did not happen (the branch after a conditional save
 *   found the state changed), so it is not the transition's;
 * - `unchecked`: it can run although a conditional save found the state changed (before the
 *   save, or before its result is checked). The effect then escapes the atomic step.
 */
export type EffectOutcome = "attributed" | "excluded" | "unchecked";

export interface PersistenceAdapter {
  readonly kind: PersistenceKind;
  /** The candidate write shapes this adapter analyzes; other shapes are not state writes for it. */
  readonly writeKinds: ReadonlySet<WriteKind>;
  /** The hint of the `unanalyzable` "no read" warning (default: read through a bound client). */
  readonly readHint?: string;
  /** Which parameter of a scope callback aliases the client (`tx` in `db.transaction(async (tx) => …)`). */
  readonly scopeAliasParam: number;
  /**
   * The atomic scope a call `<client>.<path>(…)` opens for the inline callback passed as argument
   * `argIndex`, or undefined when it opens none.
   */
  scopeKind(path: string, argIndex: number): ScopeRef["kind"] | undefined;
  /**
   * Whether a write belongs to the spec's entity, when the adapter decides it from the call shape
   * instead of the types (`entity.ts`): `prisma.order.update(…)` writes the `Order` model.
   * Undefined: decided by the types, as without the method.
   */
  matchEntity?(write: WriteNode, calls: ClientCalls, entity: EntityDecl): boolean | undefined;
  /**
   * Writes the adapter finds itself, with types, after the syntactic ones (`writes.ts`): they
   * need no narrowing probe, e.g. calls to a conditional save function.
   */
  extraWrites?(files: readonly TS.SourceFile[], entity: EntityDecl): WriteNode[];
  /** Where an attributed effect stands relative to the write (default: `attributed`). */
  effectOutcome?(input: EffectInput): EffectOutcome;
  analyzeWrite(input: AdapterInput): PersistenceFacts;
  /**
   * Atomicity per linked impl, for adapters where it depends on the call path (`memory`). When
   * present, it replaces `PersistenceFacts.atomic` and `scope`.
   */
  linkAtomicity?(input: LinkInput): LinkAtomicity;
}
