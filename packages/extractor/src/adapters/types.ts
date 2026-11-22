/**
 * A persistence adapter knows one ORM / data-access style: how a transition reads the entity, how
 * it commits the write, and which construct makes the two atomic.
 */
import type { AtomicScope, PersistenceKind } from "@tsv/ir";
import type { ts } from "ts-morph";
import type { Reach } from "../callgraph";
import type { FunctionLike } from "../cfg";
import type { ClientCall, ClientCalls, ScopeRef } from "../client-calls";
import type { WriteNode } from "../writes";

export interface PersistenceFacts {
  /** The client call whose result is the entity reference the write checks. */
  read?: ClientCall;
  /** The client call that persists the write. */
  commit?: ClientCall;
  /** The scope read and write share, when they do. */
  scope?: ScopeRef;
  /** Read and write (and commit) run inside one atomic scope. */
  atomic: boolean;
  storage?: { client: string; collection: string; key: string };
  /**
   * The expression carrying the entity's id, when there is no read call whose first argument
   * carries it (`workerId` in `this.workers.get(workerId)`). Traced to the impl's parameters for
   * `InvocationShape.entityId`.
   */
  entityKey?: ts.Expression;
  /**
   * Why atomicity could not be determined. Each becomes an `unanalyzable` warning when the linked
   * spec transition is `atomic: true` (otherwise the answer does not matter).
   */
  problems: string[];
}

export interface AdapterInput {
  write: WriteNode;
  /** The function frame containing the write (with its inline callbacks). */
  frame: FunctionLike;
  /** Calls in `frame`, in source order. */
  frameCalls: readonly ts.CallExpression[];
  calls: ClientCalls;
  checker: ts.TypeChecker;
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
  /** Which parameter of a scope callback aliases the client (`tx` in `db.transaction(async (tx) => …)`). */
  readonly scopeAliasParam: number;
  /**
   * The atomic scope a call `<client>.<path>(…)` opens for the inline callback passed as argument
   * `argIndex`, or undefined when it opens none.
   */
  scopeKind(path: string, argIndex: number): ScopeRef["kind"] | undefined;
  analyzeWrite(input: AdapterInput): PersistenceFacts;
  /**
   * Atomicity per linked impl, for adapters where it depends on the call path (`memory`). When
   * present, it replaces `PersistenceFacts.atomic` and `scope`.
   */
  linkAtomicity?(input: LinkInput): LinkAtomicity;
}
