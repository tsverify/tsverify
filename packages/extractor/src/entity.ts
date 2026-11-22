/**
 * Which spec a write belongs to, and what it writes.
 *
 * **Entity matching rule.** A write of `x.<stateField>` belongs to a spec when either
 * 1. the name of `x`'s declared type equals `entity.name` (the type's alias or symbol name, any
 *    union/intersection member, a type parameter's constraint, or `T` in `Readonly<T>`), **and**
 *    the declared type of `x.<stateField>` is a string-literal union overlapping `entity.states`,
 *    or is not a finite literal set at all (`string`, `any`; from-state is then `*`); or
 * 2. (fallback, any type name) the declared type of `x.<stateField>` is a literal union exactly
 *    equal to `entity.states` as a set.
 */
import type { EntityDecl } from "@tsv/ir";
import { ts } from "ts-morph";
import { type LiteralSet, singleLiteralOf } from "./type-facts";

export function matchesEntity(
  entity: EntityDecl,
  declared: LiteralSet,
  refTypeNames: readonly string[],
): boolean {
  const states = new Set(entity.states);
  const named = refTypeNames.includes(entity.name);
  if (declared === "*") return named;
  if (named && declared.some((v) => states.has(v))) return true;
  return declared.length === states.size && declared.every((v) => states.has(v));
}

/**
 * The literal a write stores: a string literal (through parentheses and `as`), or any
 * expression whose type is exactly one literal (`NEXT_STATE`, `Status.Paid`). Otherwise undefined.
 */
export function writtenValue(value: ts.Expression, checker: ts.TypeChecker): string | undefined {
  let e = value;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  return singleLiteralOf(checker.getTypeAtLocation(e), checker);
}
