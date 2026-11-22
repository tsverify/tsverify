/**
 * `prisma` persistence: a Prisma client bound in `bindings.clients` (or auto-detected from an
 * `@prisma/client` import, or any import of `PrismaClient`). Recognized purely by **call shape**
 * on the bound client: no generated types, no `prisma generate`, no database.
 *
 * ```ts
 * const order = await prisma.order.findUnique({ where: { id } });          // read (optional)
 * if (!order || order.status !== "paid") throw …;                           // check (narrowing)
 * await prisma.order.update({ where: { id }, data: { status: "refunded" } }); // write + commit
 * ```
 *
 * **Writes** are `data` writes (`writes.ts`): `data: { status: v }` (or `{ status: { set: v } }`) in
 * `<client>.<model>.update | updateMany | updateManyAndReturn(…)`, or the `update` object of
 * `<client>.<model>.upsert(…)`, where `<client>` is the bound client or the alias `tx` of an
 * interactive transaction. The call is the commit. Assignments and spreads are not state writes
 * here (an assigned field is never persisted), and `create` initializes a new entity, so it is not
 * a transition either. **Entity**: the write belongs to the spec whose `entity.name` equals the
 * model delegate, ignoring case (`prisma.order` → `Order`).
 *
 * **From-state and atomicity**, in order:
 * 1. **Conditional update**: the state field is in the update's `where`
 *    (`where: { id, status: "paid" }`, `status: { in: [...] }`, `{ equals }`, `{ not }`, `{ notIn }`,
 *    or any expression with a literal type, e.g. `$Enums.OrderStatus.paid`). The database checks
 *    and writes in one statement, so the write is **atomic** (`CodeSites.atomic.kind:
 *    "conditional-update"`, at the call, gate = the update's gate), and the from-state is the
 *    `where` set, with no narrowing needed. A condition it cannot read (inside `AND` / `OR` /
 *    `NOT`, or a non-literal type) still makes the update atomic, with from-state `*`.
 * 2. **Read, then update** (no state field in `where`): the from-state is the narrowed type of the
 *    read reference at the write (`order.status` after the check). The reference is `X` in
 *    `where: { id: X.id }`, else the closest `const X = await <client>.<model>.find…(…)` before the
 *    update (`writes.ts`); the read is the client call `X` was initialized with (also through
 *    helpers, as for `assign`). It is **not atomic**, except inside one interactive transaction:
 *    - `$transaction(async (tx) => …)` with read and update both through `tx` is atomic **only**
 *      with `{ isolationLevel: "Serializable" }` (or `Prisma.TransactionIsolationLevel.Serializable`,
 *      or anything typed as that literal). At the default level (READ COMMITTED on PostgreSQL) a
 *      read-then-write inside the transaction still races: it is reported `non-atomic`, plus an
 *      `info` note (`non-atomic:…:isolation-level`) that says so and suggests a conditional
 *      `updateMany` or Serializable. `RepeatableRead` and lower count as not Serializable.
 *    - The array form `$transaction([a, b])` runs its operations in one transaction but cannot
 *      check a read's result before the write: not atomic (note `…:array-transaction`).
 *    - A read through the root client inside the callback (`prisma.order.findUnique` instead of
 *      `tx.order…`) is outside the transaction: not atomic.
 * 3. **Blind update** (no state field in `where`, no read reference): nothing checks the stored
 *    state, so the write can fire from **every** state (`fromState.unconstrained`, all
 *    `entity.states`). It is one statement, so it is atomic (`conditional-update` with no state
 *    condition): the bug is the missing check, not a race.
 *
 * **Storage**: client, collection = the model delegate (`order`), key = the `where` key (`id`
 * preferred; otherwise its first plain field). The key's value is the entity key traced to the
 * impl's parameters (`InvocationShape.entityId`).
 *
 * Not modelled (see the module map backlog): nested writes (`data: { order: { update: … } }`),
 * `upsert`'s `create` branch, raw SQL (`$queryRaw … FOR UPDATE`), `$extends` / middleware that
 * rename or wrap calls, a client-wide default `transactionOptions.isolationLevel`, and reads
 * through helpers when the update's `where` does not use `X.id`.
 */
import type { EntityDecl, FromState } from "@tsv/ir";
import { ts } from "ts-morph";
import { sharedScope } from "../atomicity";
import type { ClientCall, ClientCalls } from "../client-calls";
import { symbolOf } from "../resolve";
import { literalsOf } from "../type-facts";
import { propertyNamed, unwrapArgument, type WriteNode } from "../writes";
import { findRead } from "./assign";
import type { AdapterInput, AtomicityNote, PersistenceAdapter, PersistenceFacts } from "./types";

const TRANSACTION = "$transaction";
const SERIALIZABLE = "Serializable";
const LOGICAL = new Set(["AND", "OR", "NOT"]);

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

function objectArg(call: ts.CallExpression, index: number): ts.ObjectLiteralExpression | undefined {
  const a = call.arguments[index];
  if (!a) return undefined;
  const e = strip(unwrapArgument(a) as ts.Expression);
  return ts.isObjectLiteralExpression(e) ? e : undefined;
}

function objectProp(
  o: ts.ObjectLiteralExpression | undefined,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  const p = o && propertyNamed(o, name);
  if (!p || !ts.isPropertyAssignment(p)) return undefined;
  const e = strip(p.initializer);
  return ts.isObjectLiteralExpression(e) ? e : undefined;
}

/** The value of a property; for `{ id }`, the declaration name of what `id` refers to. */
function propertyValue(
  p: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (ts.isPropertyAssignment(p)) return p.initializer;
  const decl = checker.getShorthandAssignmentValueSymbol(p)?.valueDeclaration;
  if (
    decl &&
    (ts.isParameter(decl) || ts.isVariableDeclaration(decl)) &&
    ts.isIdentifier(decl.name)
  ) {
    return decl.name;
  }
  return p.name;
}

// --- where: status condition --------------------------------------------------------------

type Condition = { values: string[] } | { reason: string };

function literalValues(e: ts.Expression, checker: ts.TypeChecker): string[] | undefined {
  const s = strip(e);
  if (ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s)) return [s.text];
  const lits = literalsOf(checker.getTypeAtLocation(s), checker);
  return lits === "*" ? undefined : [...lits];
}

function listValues(e: ts.Expression, checker: ts.TypeChecker): string[] | undefined {
  const s = strip(e);
  if (ts.isArrayLiteralExpression(s)) {
    const out: string[] = [];
    for (const el of s.elements) {
      if (ts.isSpreadElement(el)) return undefined;
      const v = literalValues(el, checker);
      if (!v) return undefined;
      out.push(...v);
    }
    return out;
  }
  const type = checker.getTypeAtLocation(s);
  const element = checker.getApparentType(type).getNumberIndexType();
  if (!element) return undefined;
  const lits = literalsOf(element, checker);
  return lits === "*" ? undefined : [...lits];
}

function mentions(node: ts.Node, field: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      ts.isIdentifier(n.name)
    ) {
      if (n.name.text === field) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The from-states a `where` admits through its state-field condition; undefined: no condition. */
function statusCondition(
  where: ts.ObjectLiteralExpression | undefined,
  field: string,
  entity: EntityDecl,
  checker: ts.TypeChecker,
): Condition | undefined {
  if (!where) return undefined;
  const prop = propertyNamed(where, field);
  if (!prop) {
    for (const p of where.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && LOGICAL.has(p.name.text)) {
        if (mentions(p.initializer, field)) {
          return {
            reason: `the \`${field}\` condition is inside \`${p.name.text}\`, which is not read`,
          };
        }
      }
    }
    return undefined;
  }
  const unknown = (what: string): Condition => ({
    reason: `the \`where.${field}\` condition (${what}) is not a set of literal states`,
  });
  const value = propertyValue(prop, checker);
  if (!value) return unknown(prop.getText());
  const e = strip(value);
  if (!ts.isObjectLiteralExpression(e)) {
    const v = literalValues(e, checker);
    return v ? { values: v } : unknown(e.getText());
  }
  let set = new Set(entity.states);
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return unknown(e.getText());
    const op = p.name.text;
    let values: string[] | undefined;
    let keep = true;
    if (op === "equals") values = literalValues(p.initializer, checker);
    else if (op === "in") values = listValues(p.initializer, checker);
    else if (op === "not" && !ts.isObjectLiteralExpression(strip(p.initializer))) {
      values = literalValues(p.initializer, checker);
      keep = false;
    } else if (op === "notIn") {
      values = listValues(p.initializer, checker);
      keep = false;
    }
    if (!values) return unknown(e.getText());
    const vs = new Set(values);
    set = new Set([...set].filter((s) => vs.has(s) === keep));
    if (keep) for (const v of values) if (!entity.states.includes(v)) set.add(v);
  }
  return { values: [...set] };
}

// --- $transaction -------------------------------------------------------------------------

/** The `isolationLevel` an interactive `$transaction(fn, options)` call passes, if readable. */
function isolationLevel(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const options = call.arguments[1];
  if (!options) return undefined;
  const o = strip(options);
  let value: ts.Expression | undefined;
  if (ts.isObjectLiteralExpression(o)) {
    const p = propertyNamed(o, "isolationLevel");
    value = p && propertyValue(p, checker);
  }
  if (value) {
    const v = strip(value);
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
    if (ts.isPropertyAccessExpression(v) && v.name.text === SERIALIZABLE) return SERIALIZABLE;
    const lits = literalsOf(checker.getTypeAtLocation(v), checker);
    return lits !== "*" && lits.length === 1 ? lits[0] : undefined;
  }
  const prop = checker.getPropertyOfType(checker.getTypeAtLocation(o), "isolationLevel");
  if (!prop) return undefined;
  const lits = literalsOf(checker.getTypeOfSymbol(prop), checker);
  return lits !== "*" && lits.length === 1 ? lits[0] : undefined;
}

/** The array-form `$transaction([…])` call an update call is an element of. */
function arrayTransaction(call: ts.CallExpression, calls: ClientCalls): ClientCall | undefined {
  let n: ts.Node = call;
  while (ts.isParenthesizedExpression(n.parent) || ts.isAwaitExpression(n.parent)) n = n.parent;
  const array = n.parent;
  if (!array || !ts.isArrayLiteralExpression(array)) return undefined;
  const outer = array.parent;
  if (
    !outer ||
    !ts.isCallExpression(outer) ||
    unwrapArgument(outer.arguments[0] as ts.Node) !== array
  ) {
    return undefined;
  }
  const cc = calls.classify(outer);
  return cc?.path === TRANSACTION ? cc : undefined;
}

// --- the adapter ----------------------------------------------------------------------------

function storageKey(
  where: ts.ObjectLiteralExpression | undefined,
  field: string,
  checker: ts.TypeChecker,
): { key: string; value: ts.Expression } | undefined {
  if (!where) return undefined;
  const plain = where.properties.filter(
    (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text !== field &&
      !LOGICAL.has(p.name.text) &&
      !(ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(strip(p.initializer))),
  );
  const chosen = plain.find((p) => (p.name as ts.Identifier).text === "id") ?? plain[0];
  const value = chosen && propertyValue(chosen, checker);
  return chosen && value ? { key: (chosen.name as ts.Identifier).text, value } : undefined;
}

function analyze(input: AdapterInput): PersistenceFacts {
  const { write, calls, checker, entity } = input;
  const call = write.call as ts.CallExpression;
  const commit = calls.classify(call) as ClientCall;
  const [model = "", method = ""] = commit.path.split(".");
  const args = objectArg(call, 0);
  const where = objectProp(args, "where");
  const field = write.field;
  const key = storageKey(where, field, checker);
  const base: PersistenceFacts = {
    commit,
    atomic: false,
    problems: [],
    ...(key ? { storage: { client: commit.client, collection: model, key: key.key } } : {}),
    ...(key ? { entityKey: key.value } : {}),
  };
  const single = { kind: "conditional-update" as const, call, gate: commit.gate };

  // 1. Conditional update: the database checks the state with the write.
  const condition = statusCondition(where, field, entity, checker);
  if (condition) {
    const fromState: FromState =
      "values" in condition
        ? {
            values: [...condition.values].sort(),
            unconstrained: entity.states.every((s) => condition.values.includes(s)),
          }
        : { values: "*", unconstrained: false, reason: condition.reason };
    const read = write.probed ? readOf(input, commit) : undefined;
    return { ...base, ...(read ? { read } : {}), atomic: true, atomicAt: single, fromState };
  }

  // 3. Blind update: nothing reads or checks the stored state.
  if (!write.probed) {
    return {
      ...base,
      atomic: true,
      atomicAt: single,
      fromState: {
        values: [...entity.states].sort(),
        unconstrained: true,
        reason: `nothing checks the stored ${field} before ${commit.gate}: its \`where\` has no \`${field}\` condition and no read of the ${model} precedes it`,
      },
    };
  }

  // 2. Read, then update.
  const refText = write.ref.getText();
  const read = readOf(input, commit);
  if (!read) {
    return {
      ...base,
      problems: [
        `no read of \`${refText}\` through a bound client was found before ${commit.gate}, so atomicity cannot be decided (reported as not atomic)`,
      ],
    };
  }
  const notes: AtomicityNote[] = [];
  const scope = sharedScope(read, write.expr, commit);
  if (scope) {
    const level = isolationLevel(scope.call, checker);
    if (level === SERIALIZABLE) return { ...base, read, scope, atomic: true };
    notes.push({
      subject: "isolation-level",
      message:
        `the interactive ${scope.gate} runs at ${level === undefined ? "the database's default isolation level (READ COMMITTED on PostgreSQL)" : `isolation level ${level}`}, ` +
        `where the read (${read.gate}) and the later ${commit.gate} still race with a concurrent transaction: both can see the old ${field} and both write`,
      hint:
        `Make the write conditional: \`${model}.updateMany({ where: { ${key?.key ?? "id"}, ${field}: <from-state> }, data: … })\` and check \`count\` (or put \`${field}\` in the \`where\` of \`${method}\`). ` +
        `Or pass \`{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }\` as the second argument of ${scope.gate} and retry on serialization failures.`,
      at: scope.call,
    });
  } else {
    const array = arrayTransaction(call, calls);
    if (array) {
      notes.push({
        subject: "array-transaction",
        message: `the array form of ${array.gate}([…]) runs its operations in one transaction, but ${field} was checked on an earlier read (${read.gate}), so the check and ${commit.gate} still race`,
        hint: `Put the from-state in the update's \`where\` (\`${field}: <from-state>\`) and check the result, or use an interactive Serializable transaction.`,
        at: array.call,
      });
    }
  }
  return { ...base, read, atomic: false, ...(notes.length > 0 ? { notes } : {}) };
}

/** The read the probed reference comes from: a call on the same client as the update. */
function readOf(input: AdapterInput, commit: ClientCall): ClientCall | undefined {
  const ref = strip(input.write.ref);
  if (!ts.isIdentifier(ref)) return undefined;
  const read = findRead(input, symbolOf(ref, input.checker));
  return read &&
    read.client === commit.client &&
    read.path.split(".")[0] === commit.path.split(".")[0]
    ? read
    : undefined;
}

export const prismaAdapter: PersistenceAdapter = {
  kind: "prisma",
  writeKinds: new Set(["data"]),
  scopeAliasParam: 0,

  scopeKind(path, argIndex) {
    return path === TRANSACTION && argIndex === 0 ? "transaction" : undefined;
  },

  matchEntity(write: WriteNode, calls: ClientCalls, entity: EntityDecl): boolean {
    const cc = write.call && calls.classify(write.call);
    if (!cc) return false;
    const segments = cc.path.split(".");
    return segments.length === 2 && segments[0]?.toLowerCase() === entity.name.toLowerCase();
  },

  analyzeWrite: analyze,
};
