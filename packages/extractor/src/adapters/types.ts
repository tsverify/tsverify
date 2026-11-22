/**
 * A persistence adapter knows one ORM / data-access style: how a transition reads the entity, how
 * it commits the write, and which construct makes the two atomic.
 */
import type { AtomicScope, EntityDecl, FromState, PersistenceKind } from "@tsverify/ir";
import type { ts } from "ts-morph";
import type { Callees, Reach } from "../callgraph";
import type { FunctionLike } from "../cfg";
import type { ClientCall, ClientCalls, ScopeRef } from "../client-calls";
import type { WriteKind, WriteNode } from "../writes";

/** Context for a "not atomic" verdict: becomes `CodeSites.atomicNote` (the reason in `non-atomic`). */
export interface AtomicityNote {
  /** Short kind, e.g. `isolation-level` (for tests and debugging). */
  subject: string;
  message: string;
  hint: string;
  /** Where the note points (e.g. the `$transaction` call). */
  at: ts.Node;
}

export interface PersistenceFacts {
  /** The client call whose result is the entity reference the write checks. */
  read?: ClientCall;
  /** The client call that persists the write. */
  commit?: ClientCall;
  /** The scope read and write share, when they do (and it makes them atomic). */
  scope?: ScopeRef;
  /** Read and write (and commit) run inside one atomic scope. */
  atomic: boolean;
  /**
   * The atomic construct when it is not a shared callback scope, e.g. a conditional update:
   * recorded as `CodeSites.atomic` at `call`. Takes precedence over `scope`.
   */
  atomicAt?: { kind: AtomicScope["kind"]; call: ts.CallExpression; gate: string };
  /** The from-state when the persistence call itself decides it (an update's `where`). */
  fromState?: FromState;
  storage?: { client: string; collection: string; key: string };
  /**
   * The expression carrying the entity's id, when there is no read call whose first argument
   * carries it (`workerId` in `this.workers.get(workerId)`, `orderId` in `where: { id: orderId }`).
   * Traced to the impl's parameters for `InvocationShape.entityId`.
   */
  entityKey?: ts.Expression;
  /**
   * Why atomicity could not be determined. Each becomes an `unanalyzable` warning when the linked
   * spec transition is `atomic: true` (otherwise the answer does not matter).
   */
  problems: string[];
  /** Why the write is not atomic although it looks scoped; the first becomes `CodeSites.atomicNote`. */
  notes?: AtomicityNote[];
}

export interface AdapterInput {
  write: WriteNode;
  /** The function frame containing the write (with its inline callbacks). */
  frame: FunctionLike;
  /** Calls in `frame`, in source order. */
  frameCalls: readonly ts.CallExpression[];
  calls: ClientCalls;
  callees: Callees;
  checker: ts.TypeChecker;
  /** The spec's entity. */
  entity: EntityDecl;
}

/** One write as reached from one impl (or, unlinked, from its own frame). */
export interface LinkInput {
  write: WriteNode;
  frame: FunctionLike;
  reach: Reach;
  checker: ts.TypeChecker;
}

/** Atomicity that depends on the path from the impl to the write. */
export interface LinkAtomicity {
  atomic: boolean;
  /** The scope kind recorded in `CodeSites.atomic` (at the write) when atomic. */
  kind?: AtomicScope["kind"];
}

export interface PersistenceAdapter {
  readonly kind: PersistenceKind;
  /** The candidate write shapes this adapter analyzes; other shapes are not state writes for it. */
  readonly writeKinds: ReadonlySet<WriteKind>;
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
   */
  matchEntity?(write: WriteNode, calls: ClientCalls, entity: EntityDecl): boolean;
  analyzeWrite(input: AdapterInput): PersistenceFacts;
  /**
   * Atomicity per linked impl, for adapters where it depends on the call path (`memory`). When
   * present, it replaces `PersistenceFacts.atomic` and `scope`.
   */
  linkAtomicity?(input: LinkInput): LinkAtomicity;
}
