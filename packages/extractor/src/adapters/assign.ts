/**
 * `assign` persistence: a repository-style client whose collections are read and saved as whole
 * objects, with the state changed by plain assignment or by a spread passed to the commit.
 *
 * ```ts
 * await db.transaction(async (tx) => {           // scope: <client>.transaction(callback), param 0 = alias
 *   const order = await tx.orders.get(orderId);  // read: the client call initializing the reference
 *   order.status = "shipped";                    // write
 *   await tx.orders.save(order);                 // commit: next client call taking the reference
 * });
 * await db.orders.save({ ...order, status: "refunded" }); // spread write: the call is the commit
 * ```
 *
 * Storage: the read's client, its path minus the method (`orders.get` → `orders`), and key `id`
 * when the entity type has an `id` property.
 */
import { ts } from "ts-morph";
import { sharedScope } from "../atomicity";
import type { ClientCall } from "../client-calls";
import { symbolOf } from "../resolve";
import { declaredTypeOfRef } from "../type-facts";
import { parentSkippingWrappers, referenceText, unwrapArgument } from "../writes";
import type { AdapterInput, PersistenceAdapter, PersistenceFacts } from "./types";

function strip(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAwaitExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function findRead(input: AdapterInput, refSym: ts.Symbol | undefined): ClientCall | undefined {
  const decl = refSym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = strip(decl.initializer);
  return ts.isCallExpression(init) ? input.calls.classify(init) : undefined;
}

function findCommit(
  input: AdapterInput,
  refSym: ts.Symbol | undefined,
  read: ClientCall | undefined,
): ClientCall | undefined {
  const { write, calls, checker } = input;
  if (write.kind === "spread") {
    const parent = parentSkippingWrappers(write.expr);
    return parent && ts.isCallExpression(parent) ? calls.classify(parent) : undefined;
  }
  if (!refSym) return undefined;
  const after = write.expr.getEnd();
  for (const call of input.frameCalls) {
    if (call.getStart() < after) continue;
    const cc = calls.classify(call);
    if (!cc || (read && cc.client !== read.client)) continue;
    const passesRef = call.arguments.some((a) => {
      const arg = strip(unwrapArgument(a) as ts.Expression);
      return ts.isIdentifier(arg) && symbolOf(arg, checker) === refSym;
    });
    if (passesRef) return cc;
  }
  return undefined;
}

export const assignAdapter: PersistenceAdapter = {
  kind: "assign",
  scopeAliasParam: 0,

  scopeKind(path, argIndex) {
    return path === "transaction" && argIndex === 0 ? "transaction" : undefined;
  },

  analyzeWrite(input): PersistenceFacts {
    const { write, checker } = input;
    const problems: string[] = [];
    const ref = strip(write.ref);
    const refSym = ts.isIdentifier(ref) ? symbolOf(ref, checker) : undefined;
    const refText = referenceText(write.ref) ?? write.ref.getText();
    const read = findRead(input, refSym);
    if (!read) {
      problems.push(
        `no read of \`${refText}\` through a bound client was found before this write, so ` +
          "atomicity cannot be decided (reported as not atomic)",
      );
    }
    const commit = findCommit(input, refSym, read);
    const scope = sharedScope(read, write.expr, commit);
    const source = read ?? commit;
    let storage: PersistenceFacts["storage"];
    if (source) {
      const segments = source.path.split(".");
      const collection = segments.slice(0, -1).join(".");
      const refType = declaredTypeOfRef(write.ref, checker);
      const hasId = checker.getPropertyOfType(checker.getApparentType(refType), "id") !== undefined;
      if (collection !== "" && hasId) storage = { client: source.client, collection, key: "id" };
    }
    return { read, commit, scope, atomic: scope !== undefined, storage, problems };
  },
};
