import { UNCONFIRMED_SUBJECT } from "@tsverify/conformance";
import type { BehaviorModel, Expr, Finding, SourceLocation, Trace } from "@tsverify/ir";

/**
 * Root-cause links: `causedBy` on code-model checker findings (`implementation-property`) that a
 * conformance finding of the same run explains. Only the CLI sees both kinds, so it links them
 * after steps 3–5 of `tsverify check` (see `code-conformance.ts`).
 *
 * The rule is deliberately conservative: a cause is linked only when its kind can produce that
 * counterexample, and the counterexample uses it. Code that does **more** than the spec allows
 * shows as a step of the trace that is impossible under the spec, for exactly the reason the
 * conformance finding gives. A step "of the write" is one whose action is by the code transition
 * the finding is about: the one at the finding's `codeAt` (the write) among those linked to `t`,
 * else every write of `t.to` reached from `t`'s impl (`t`, `t~2`, …; `t->x` for a write of another
 * state). With `status` the status just before that step and `from` the spec's `from` for `t`:
 *
 * | Conformance finding on `t`                          | Linked when the trace has a step of the write that… |
 * |-----------------------------------------------------|----------------------------------------|
 * | `undeclared-transition` (an unlinked write, or `t` also writing another state) | is any action: the spec has no such transition at all |
 * | `from-state-unconstrained` / `from-state-mismatch` error (the code accepts more) | is an `atomic` or `read` with `status ∉ from`: the state check the spec asks for would have rejected it |
 * | `non-atomic`                                        | is a `write` with `status ∉ from` and `status ≠` the status that worker observed at its read: the state changed in the check-then-act gap, and an atomic `t` would have rejected it |
 *
 * An effect mismatch changes only how often an effect is counted, so it explains only a rule
 * (`always`, `never`, `eventually`) that counts that effect, in the direction the mismatch moves
 * the count, along a trace that takes a step of `t`:
 *
 * | Conformance finding on `t`                     | Linked to a rule violated by… |
 * |------------------------------------------------|-------------------------------|
 * | `missing-effect` error (the code never calls it) | fewer of the effect: `never: count(effect e) < 1`, `always: count(effect e) >= 1`, not `never: … count(effect e) > 0` |
 * | `undeclared-effect` (the code calls one more)  | more of the effect: `always: count(effect e) <= 1`, `never: count(effect e) > 1` |
 *
 * Code that does **less** than the spec (a transition the code model lacks, from some or all of
 * its spec from-states) never shows as a step: it shows as an entity that stops where the spec
 * would go on. So these causes explain a **liveness** counterexample (`no-stuck-states`, an
 * `eventually` rule), whose trace ends in a state where nothing can happen any more, when `t`
 * would leave that end state in the spec (`status ∈` the states it lacks, `status ≠ t.to`):
 *
 * | Conformance finding on `t`                          | States the code lacks `t` from |
 * |-----------------------------------------------------|--------------------------------|
 * | `missing-transition`                                | all of the spec's `from` |
 * | `unanalyzable` `…:<t>:unconfirmed` (writes tsverify can't read) | all of the spec's `from` |
 * | `from-state-mismatch` warning (the code is stricter) | the spec's `from` minus the code's |
 *
 * Removing behavior never breaks an `always` / `never` rule, so these never explain an invariant.
 * `from: "*"` never links through a step (no status is outside it), nor does a transition the
 * spec doesn't declare (other than through `undeclared-transition`). Other conformance categories
 * (guards; an effect tsverify couldn't confirm, which the code model has as specified) are never
 * linked: their effect on a trace can't be read off it. A finding may have several causes; they
 * keep the order of `findings`.
 */
export function linkRootCauses(
  findings: readonly Finding[],
  spec: BehaviorModel,
  code?: BehaviorModel,
): Finding[] {
  const causes = findings.filter((f) => CAUSE_CATEGORIES.has(f.category) || isUnconfirmed(f));
  if (causes.length === 0) return [...findings];
  return findings.map((f) => {
    if (f.category !== "implementation-property" || f.trace === undefined) return f;
    const trace = f.trace;
    const linked = causes
      .filter(
        (c) =>
          c.behavior === f.behavior &&
          (explains(c, trace, spec, code) ||
            explainsEnd(c, trace, spec, code) ||
            explainsCount(c, f, trace, spec, code)),
      )
      .map((c) => c.id);
    if (linked.length === 0) return f;
    return { ...f, causedBy: [...new Set([...(f.causedBy ?? []), ...linked])] };
  });
}

const CAUSE_CATEGORIES: ReadonlySet<Finding["category"]> = new Set([
  "undeclared-transition",
  "from-state-unconstrained",
  "from-state-mismatch",
  "non-atomic",
  "missing-transition",
  "missing-effect",
  "undeclared-effect",
]);

/** The `unanalyzable` finding of a transition whose impl writes the state only unreadably. */
function isUnconfirmed(f: Finding): boolean {
  return (
    f.category === "unanalyzable" &&
    f.transition !== undefined &&
    f.id.endsWith(`:${f.transition}:${UNCONFIRMED_SUBJECT}`)
  );
}

/**
 * The spec states the code model lacks `cause`'s transition from, when `cause` says the code
 * does less than the spec (the second table above); undefined for every other finding.
 */
function lackedFrom(
  cause: Finding,
  spec: BehaviorModel,
  code: BehaviorModel | undefined,
): string[] | undefined {
  const t = spec.transitions.find((x) => x.name === cause.transition);
  if (t === undefined) return undefined;
  const specFrom = t.from === "*" ? spec.entity.states : t.from;
  if (cause.category === "missing-transition" || isUnconfirmed(cause)) return specFrom;
  if (cause.category !== "from-state-mismatch" || cause.severity !== "warning") return undefined;
  if (code === undefined) return undefined;
  const codeFrom = new Set<string>();
  for (const c of code.transitions) {
    if (c.sites?.specTransition !== t.name || c.to !== t.to) continue;
    if (c.from === "*") return undefined;
    for (const st of c.from) codeFrom.add(st);
  }
  return specFrom.filter((st) => !codeFrom.has(st));
}

/**
 * Whether `cause` (code that lacks some of a transition) explains a liveness counterexample: the
 * spec's transition would leave the status the trace ends in (see the second table above).
 */
function explainsEnd(
  cause: Finding,
  trace: Trace,
  spec: BehaviorModel,
  code: BehaviorModel | undefined,
): boolean {
  if (trace.kind !== "liveness") return false;
  const end = trace.steps[trace.steps.length - 1]?.state.status;
  const t = spec.transitions.find((x) => x.name === cause.transition);
  if (end === undefined || t === undefined || t.to === end) return false;
  return lackedFrom(cause, spec, code)?.includes(end) ?? false;
}

function sameAt(a: SourceLocation | undefined, b: SourceLocation | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.file === b.file &&
    a.line === b.line &&
    a.column === b.column
  );
}

/**
 * Which code transitions (trace action names) `cause` is about: see "a step of the write" in the
 * comment on `linkRootCauses`. Undefined when `cause` is about no write.
 */
function writesOf(
  cause: Finding,
  spec: BehaviorModel,
  code: BehaviorModel | undefined,
): ((name: string) => boolean) | undefined {
  const name = cause.transition;
  if (name === undefined) return undefined;
  const unlinked =
    cause.category === "undeclared-transition" &&
    cause.id === `undeclared-transition:${cause.behavior}:${name}`;
  if (unlinked) return (n) => n === name;
  const t = spec.transitions.find((x) => x.name === name);
  if (t === undefined) return undefined;
  const primary = cause.category !== "undeclared-transition";
  const sited = (code?.transitions ?? []).filter(
    (c) => c.sites?.specTransition === name && (c.to === t.to) === primary,
  );
  // An effect finding is about every write of `t.to` (its call site is not a write).
  const at = cause.category.endsWith("-effect") ? undefined : cause.codeAt;
  const exact = sited.filter((c) => sameAt(c.sites?.write, at)).map((c) => c.name);
  if (exact.length > 0) return (n) => exact.includes(n);
  if (sited.length > 0) return (n) => sited.some((c) => c.name === n);
  // A code model without sites: by the naming convention (`ModelOrigin`).
  return primary ? (n) => n === name || n.startsWith(`${name}~`) : (n) => n.startsWith(`${name}->`);
}

/** Whether `cause` (a conformance finding) explains some step of `trace`; see the table above. */
function explains(
  cause: Finding,
  trace: Trace,
  spec: BehaviorModel,
  code: BehaviorModel | undefined,
): boolean {
  const { category } = cause;
  const stepwise =
    category === "undeclared-transition" ||
    category === "from-state-unconstrained" ||
    (category === "from-state-mismatch" && cause.severity === "error") ||
    category === "non-atomic";
  if (!stepwise) return false;
  const ofWrite = writesOf(cause, spec, code);
  if (ofWrite === undefined) return false;
  const declared = spec.transitions.find((t) => t.name === cause.transition);
  const outsideFrom = (status: string) =>
    declared !== undefined && declared.from !== "*" && !declared.from.includes(status);

  for (let i = 1; i < trace.steps.length; i++) {
    const action = trace.steps[i]?.action;
    const before = trace.steps[i - 1]?.state;
    if (action === undefined || before === undefined || !ofWrite(action.transition)) continue;
    const status = before.status;
    if (category === "undeclared-transition") return true;
    if (category === "non-atomic") {
      if (action.kind !== "write") continue;
      const worker = trace.steps[i]?.state.workers.find((w) => w.id === action.worker);
      if (worker !== undefined && worker.observed !== status && outsideFrom(status)) return true;
    } else if (action.kind !== "write" && outsideFrom(status)) {
      return true;
    }
  }
  return false;
}

/** The effect an effect finding on transition `t` is about (its id's subject). */
function effectOf(cause: Finding, names: Iterable<string>): string | undefined {
  const prefix = `${cause.category}:${cause.behavior}:${cause.transition}:`;
  for (const name of names) {
    if (cause.id === `${prefix}${name}` || cause.id.startsWith(`${prefix}${name}:`)) return name;
  }
  return undefined;
}

/** The effects `expr` counts, with the comparisons on each and whether they sit under a `not`. */
function counts(
  expr: Expr,
  positive: boolean,
  out: { effect: string; op: string; positive: boolean }[],
) {
  switch (expr.type) {
    case "effect-count":
      out.push({ effect: expr.effect, op: expr.op, positive });
      break;
    case "not":
      counts(expr.expr, !positive, out);
      break;
    case "and":
    case "or":
      counts(expr.left, positive, out);
      counts(expr.right, positive, out);
      break;
    case "implies":
      counts(expr.left, !positive, out);
      counts(expr.right, positive, out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Whether changing how often `effect` is counted (`fewer`, or more) can make `rule` fail: its
 * violation (`never`: the expression holds; `always` and `eventually`: it doesn't) has a
 * comparison on the effect's count that the change can make true.
 */
function countCanBreak(rule: BehaviorModel["rules"][number], effect: string, fewer: boolean) {
  const violation = rule.kind === "never";
  const rising = new Set([">", ">=", "==", "!="]);
  const falling = new Set(["<", "<=", "==", "!="]);
  return counts(rule.expr, violation, []).some(({ effect: e, op, positive }) => {
    if (e !== effect) return false;
    // A positive comparison becomes true as the count moves its way; a negated one, as it
    // moves the other way.
    const becomesTrue = fewer === positive ? falling : rising;
    return becomesTrue.has(op);
  });
}

/**
 * Whether `cause` (an effect mismatch on `t`) explains `finding`, a rule violation: the rule
 * counts the effect, the mismatch moves the count the way that breaks it (see the effect table
 * above), and the trace takes a step of `t`.
 */
function explainsCount(
  cause: Finding,
  finding: Finding,
  trace: Trace,
  spec: BehaviorModel,
  code: BehaviorModel | undefined,
): boolean {
  if (cause.category !== "missing-effect" && cause.category !== "undeclared-effect") return false;
  // A missing effect tsverify couldn't confirm is in the code model as specified.
  if (cause.severity !== "error") return false;
  const ruleName = finding.property?.startsWith("rule:") ? finding.property.slice(5) : undefined;
  const rule = spec.rules.find((r) => r.name === ruleName);
  if (rule === undefined) return false;
  const effect = effectOf(
    cause,
    counts(rule.expr, true, []).map((c) => c.effect),
  );
  if (effect === undefined) return false;
  if (!countCanBreak(rule, effect, cause.category === "missing-effect")) return false;
  const ofWrite = writesOf(cause, spec, code);
  return (
    ofWrite !== undefined &&
    trace.steps.some((step) => step.action !== undefined && ofWrite(step.action.transition))
  );
}
