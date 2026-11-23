/**
 * A from-state check tsverify can't read. When nothing narrows the entity's state field before a
 * write (its type there is the full declared union), the code may still check it in a form the
 * type checker doesn't narrow through: a lookup table (`TRANSITIONS[row.status].includes(to)`), a
 * helper that throws (`assertTransition(row, to)`, `assertCanResolve(row.status)`), a copy
 * (`const { status } = row`). Reporting `from-state-unconstrained` ("status is not checked") would
 * then be wrong; the write's from-state is unknown instead.
 *
 * `unreadCheckOf` finds the first such use of the write's entity reference in the write's
 * function (with its inline callbacks), before the write: its state field read in any way other
 * than the forms tsverify reads (a comparison with a literal, a `switch`, `.includes` / `.has`
 * on a literal list or a `const`: one of those that left the type whole doesn't stop the write,
 * so it is not a check), or
 * the reference passed whole to a call that isn't a bound client, storage function or guard. A
 * field that is never consulted gives none, and the write stays `from-state-unconstrained`.
 */
import { type FunctionLike, inlineCallbackCall, isFunctionLike } from "./cfg";
import { symbolOf } from "./resolve";
import type * as TS from "./ts-types";
import { constInitializer, literalsOf, stripExpr } from "./type-facts";
import { ts } from "./typescript";
import { oneLine, referenceText, type WriteNode } from "./writes";

export interface UnreadCheck {
  /** The expression (or statement) that consults the state. */
  at: TS.Node;
  /** Its source, on one line, shortened. */
  text: string;
}

function isComparison(kind: TS.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

/**
 * `e` is an operand of `=== <literal>` (either side), the discriminant of a `switch`, or the
 * argument of `.includes` / `.has` on a literal list or a `const` (the forms tsverify reads).
 */
function isPlainCheck(e: TS.Node, checker: TS.Checker): boolean {
  let child: TS.Node = e;
  let p = e.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p))) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isSwitchStatement(p) && p.expression === child) return true;
  if (
    ts.isCallExpression(p) &&
    p.arguments[0] === child &&
    ts.isPropertyAccessExpression(p.expression) &&
    (p.expression.name.text === "includes" || p.expression.name.text === "has")
  ) {
    const list = stripExpr(p.expression.expression);
    return (
      ts.isArrayLiteralExpression(list) ||
      (ts.isIdentifier(list) && constInitializer(list, checker) !== undefined)
    );
  }
  if (ts.isBinaryExpression(p) && isComparison(p.operatorToken.kind)) {
    const other = stripExpr(p.left === child ? p.right : p.left);
    return (
      ts.isStringLiteral(other) ||
      ts.isNoSubstitutionTemplateLiteral(other) ||
      ts.isPropertyAccessExpression(other) // an enum member, `OrderStatus.paid`
    );
  }
  // A message (`throw new Error(\`… ${row.status}\`)`) or a log is not a check.
  return ts.isTemplateSpan(p);
}

/** The expression a use belongs to, for the message: the whole condition or statement expression. */
function enclosingExpression(n: TS.Node): TS.Node {
  let cur = n;
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isIfStatement(p) || ts.isWhileStatement(p)) return p.expression;
    if (
      ts.isExpressionStatement(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isReturnStatement(p) ||
      ts.isThrowStatement(p) ||
      isFunctionLike(p) ||
      ts.isBlock(p)
    ) {
      return ts.isVariableDeclaration(p) ? p : cur;
    }
    cur = p;
  }
  return cur;
}

function shortened(n: TS.Node, max = 60): string {
  const text = oneLine(n);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function unreadCheckOf(
  write: WriteNode,
  frame: FunctionLike,
  checker: TS.Checker,
  ignoreCall: (call: TS.CallExpression) => boolean,
): UnreadCheck | undefined {
  const ref = stripExpr(write.ref);
  const refText = referenceText(ref);
  if (refText === undefined) return undefined;
  const sym = ts.isIdentifier(ref) ? symbolOf(ref, checker) : undefined;
  const isRef = (e: TS.Expression): boolean => {
    const x = stripExpr(e);
    if (sym) return ts.isIdentifier(x) && symbolOf(x, checker) === sym;
    return referenceText(x) === refText;
  };
  const field = write.field;
  // Before the write and before the narrowing probe wrapping it (`(order.status, <write>)`).
  let wrapped: TS.Node = write.expr;
  while (
    ts.isParenthesizedExpression(wrapped.parent) ||
    (ts.isBinaryExpression(wrapped.parent) &&
      wrapped.parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      wrapped.parent.right === wrapped)
  ) {
    wrapped = wrapped.parent;
  }
  const limit = Math.min(write.site.getStart(), wrapped.getStart());
  let found: TS.Node | undefined;
  const visit = (n: TS.Node): void => {
    if (found || n.getStart() >= limit) return;
    if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === field && isRef(n.expression)) {
      const assigned =
        ts.isBinaryExpression(n.parent) &&
        n.parent.left === n &&
        n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!assigned && !isPlainCheck(n, checker)) found = n;
      return;
    }
    if (
      ts.isElementAccessExpression(n) &&
      isRef(n.expression) &&
      ts.isStringLiteral(n.argumentExpression) &&
      n.argumentExpression.text === field
    ) {
      found = n;
      return;
    }
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      ts.isObjectBindingPattern(n.name) &&
      isRef(n.initializer) &&
      n.name.elements.some((e) => ((e.propertyName ?? e.name) as TS.Node).getText() === field)
    ) {
      found = n;
      return;
    }
    if (ts.isCallExpression(n) && !ignoreCall(n) && n.arguments.some((a) => isRef(a))) {
      found = n;
      return;
    }
    n.forEachChild(visit);
  };
  if (frame.body) visit(frame.body);
  if (!found) return undefined;
  const at = enclosingExpression(found);
  return { at: found, text: shortened(at) };
}

/**
 * A check on another state-like field before a write whose own state nothing checks: a comparison
 * of a field with a string literal (`snapshot.executionStatus === "FINISHED"`), a `switch` on it,
 * `.includes` / `.has` of it, or the field passed to a function (`isFinished(run.executionStatus)`),
 * where the field's type is a union of two or more string literals and it is not the write's own
 * state field (`isOwnState`). Searched like `unreadCheckOf`: the write's function with its inline
 * callbacks, before the write. Of several, the first whose name says state (`…status`, `…state`)
 * wins, else the first. The code then guards the write with a state the spec doesn't model
 * (another entity's, or a second field of this one): a modelling question, which the
 * `from-state-unconstrained` message names.
 */
export function otherFieldCheckOf(
  write: WriteNode,
  frame: FunctionLike,
  checker: TS.Checker,
  isOwnState: (access: TS.PropertyAccessExpression) => boolean,
): string | undefined {
  const limit = write.site.getStart();
  const stateLike = (e: TS.Expression): TS.PropertyAccessExpression | undefined => {
    const x = stripExpr(e);
    if (!ts.isPropertyAccessExpression(x) || isOwnState(x)) return undefined;
    const type = checker.getTypeAtLocation(x);
    const lits = literalsOf(type, checker);
    if (lits === "*" || lits.length < 2) return undefined;
    const parts = type?.isUnionType() ? type.getTypes() : [];
    return parts.some((p) => p.isStringLiteralType()) ? x : undefined;
  };
  const isText = (e: TS.Expression) => {
    const x = stripExpr(e);
    return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x);
  };
  const found: TS.PropertyAccessExpression[] = [];
  const add = (x: TS.PropertyAccessExpression | undefined) => {
    if (x) found.push(x);
  };
  const visit = (n: TS.Node): void => {
    if (n.getStart() >= limit) return;
    if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
    if (ts.isBinaryExpression(n) && isComparison(n.operatorToken.kind)) {
      if (isText(n.right)) add(stateLike(n.left));
      else if (isText(n.left)) add(stateLike(n.right));
    } else if (ts.isSwitchStatement(n)) {
      add(stateLike(n.expression));
    } else if (ts.isCallExpression(n)) {
      for (const a of n.arguments) if (!ts.isSpreadElement(a)) add(stateLike(a));
    }
    n.forEachChild(visit);
  };
  if (frame.body) visit(frame.body);
  const best = found.find((x) => /status|state/i.test(x.name.text)) ?? found[0];
  return best && shortened(best);
}
