/**
 * A persistence adapter knows one ORM / data-access style: how a transition reads the entity, how
 * it commits the write, and which construct makes the two atomic.
 */
import type { PersistenceKind } from "@tsv/ir";
import type { ts } from "ts-morph";
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
  /** Why something could not be determined (becomes an `unanalyzable` warning). */
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
}
