/**
 * `memory` persistence: in-process objects with no client. The state changes by plain
 * assignment to the entity's state field, and nothing reads or commits it through a client.
 *
 * ```ts
 * markWaiting(workerId: string): void {
 *   const w = this.workers.get(workerId);   // entity key: the `get` / element-access argument
 *   if (w?.status !== "running") throw …;   // check (narrowing, as for every adapter)
 *   w.status = "waiting";                    // write; atomic: no suspension since the impl's entry
 * }
 * ```
 *
 * - No `read` / `commit` sites, no `storage`, no `unanalyzable` "no read" warnings.
 * - Atomic iff no `await` / `yield` / `for await` step (or deferred callback) lies on a path from
 *   the last re-check of the entity's state field (`if (w.status !== "x") return`) to the write,
 *   or from the impl's entry on paths without a re-check, across the impl → helper calls that
 *   lead to it (`suspensionBefore` in `atomicity.ts`); then `CodeSites.atomic` is `synchronous`,
 *   at the write.
 * - Entity key, for `InvocationShape.entityId`: when the entity reference is (a `const` initialized
 *   with) `<expr>.get(key)` or `<expr>[key]`. An entity that is `this`, or a parameter passed as
 *   the object itself, has no key, so no invocation shape is recorded.
 *
 * Never auto-detected: set `bindings.persistence: memory`.
 */
import { suspensionBefore } from "../atomicity";
import { valueDeclarationOf } from "../declarations";
import { symbolOf } from "../resolve";
import type * as TS from "../ts-types";
import { ts } from "../typescript";
import type { AdapterInput, PersistenceAdapter, PersistenceFacts } from "./types";

function strip(e: TS.Expression): TS.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function keyOfLookup(e: TS.Expression): TS.Expression | undefined {
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "get" &&
    e.arguments.length === 1
  ) {
    const arg = e.arguments[0] as TS.Expression;
    return ts.isSpreadElement(arg) ? undefined : arg;
  }
  if (ts.isElementAccessExpression(e)) return e.argumentExpression;
  return undefined;
}

/** The id expression of a keyed lookup the entity reference comes from, if any. */
function entityKeyOf(ref: TS.Expression, checker: TS.Checker): TS.Expression | undefined {
  const e = strip(ref);
  if (!ts.isIdentifier(e)) return keyOfLookup(e);
  const decl = valueDeclarationOf(symbolOf(e, checker));
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
  return keyOfLookup(strip(decl.initializer));
}

export const memoryAdapter: PersistenceAdapter = {
  kind: "memory",
  writeKinds: new Set(["assign", "spread"]),
  scopeAliasParam: -1,

  scopeKind() {
    return undefined;
  },

  analyzeWrite(input: AdapterInput): PersistenceFacts {
    const entityKey = entityKeyOf(input.write.ref, input.checker);
    return { atomic: false, problems: [], ...(entityKey ? { entityKey } : {}) };
  },

  linkAtomicity({ write, frame, reach, checker }) {
    const atomic = suspensionBefore(reach, frame, write, checker) === undefined;
    return atomic ? { atomic, kind: "synchronous" } : { atomic };
  },
};
