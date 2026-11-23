/**
 * The literal arguments of a guard call, as canonical text that compares equal to a guard
 * binding's arguments (`parseGuardArgs` in `@tsverify/ir`): a string, number or boolean is its
 * value (`"admin"` → `admin`), a list of those is `formatGuardArgList` of its items
 * (`['owner', "admin"]` → `["owner", "admin"]`). A list is read from an array literal (also
 * through `as const`, `satisfies` and parentheses) or from a `const` initialised with one.
 * Arguments that are none of these (`ctx`, `{ ownerId }`, a computed list) are left out, so
 * `requireRole(tx, ctx, ["owner", "admin"], { ownerId })` passes `[["owner", "admin"]]`.
 */
import { formatGuardArgList } from "@tsverify/ir";
import type * as TS from "./ts-types";
import { constInitializer, singleLiteralOf, stripExpr } from "./type-facts";
import { ts } from "./typescript";

function scalarOf(e: TS.Expression, checker: TS.Checker): string | undefined {
  const a = stripExpr(e);
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isNumericLiteral(a)) {
    return a.text;
  }
  if (a.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (a.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return singleLiteralOf(checker.getTypeAtLocation(a), checker);
}

/** The array literal `e` is, or a `const` it names is initialised with. */
function arrayLiteralOf(
  e: TS.Expression,
  checker: TS.Checker,
): TS.ArrayLiteralExpression | undefined {
  const a = stripExpr(e);
  if (ts.isArrayLiteralExpression(a)) return a;
  const init = ts.isIdentifier(a) ? constInitializer(a, checker) : undefined;
  const list = init && stripExpr(init);
  return list && ts.isArrayLiteralExpression(list) ? list : undefined;
}

/** One argument's canonical text, or undefined when it is not a literal or a list of literals. */
export function guardArgOf(e: TS.Expression, checker: TS.Checker): string | undefined {
  const list = arrayLiteralOf(e, checker);
  if (!list) return scalarOf(e, checker);
  const items: string[] = [];
  for (const el of list.elements) {
    if (ts.isSpreadElement(el)) return undefined;
    const v = scalarOf(el, checker);
    if (v === undefined) return undefined;
    items.push(v);
  }
  return formatGuardArgList(items);
}

/** The call's literal arguments, in order, skipping the others. */
export function guardArgs(call: TS.CallExpression, checker: TS.Checker): string[] {
  const out: string[] = [];
  for (const a of call.arguments) {
    const v = guardArgOf(a, checker);
    if (v !== undefined) out.push(v);
  }
  return out;
}
