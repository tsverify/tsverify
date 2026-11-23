import { UNCONFIRMED_SUBJECT } from "@tsverify/conformance";
import type { BehaviorModel, Finding, Trace } from "@tsverify/ir";

/**
 * Root-cause links: `causedBy` on code-model checker findings (`implementation-property`) that a
 * conformance finding of the same run explains. Only the CLI sees both kinds, so it links them
 * after steps 3–5 of `tsverify check` (see `code-conformance.ts`).
 *
 * The rule is deliberately conservative. A cause is linked only when the counterexample uses
 * the mismatch. Code that does **more** than the spec allows shows as a step of the trace that is
 * impossible under the spec, for exactly the reason the conformance finding gives. For a step
 * whose action is by transition `t`, with `status` the status just before that step and `from`
 * the spec's `from` for `t`:
 *
 * | Conformance finding on `t`                          | Linked when the trace has a step that… |
 * |-----------------------------------------------------|----------------------------------------|
 * | `undeclared-transition` (an unlinked code transition) | is any action of `t`: the spec has no such transition at all |
 * | `from-state-unconstrained` / `from-state-mismatch`  | is an `atomic` or `read` of `t` with `status ∉ from`: the state check the spec asks for would have rejected it |
 * | `non-atomic`                                        | is a `write` of `t` with `status ∉ from` and `status ≠` the status that worker observed at its read: the state changed in the check-then-act gap, and an atomic `t` would have rejected it |
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
 * (guards, effects) are never linked: their effect on a trace can't be read off its steps. A
 * finding may have several causes; they keep the order of `findings`.
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
          (explains(c, trace, spec) || explainsEnd(c, trace, spec, code)),
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

/** Whether `cause` (a conformance finding) explains some step of `trace`; see the table above. */
function explains(cause: Finding, trace: Trace, spec: BehaviorModel): boolean {
  const name = cause.transition;
  if (name === undefined) return false;
  const declared = spec.transitions.find((t) => t.name === name);
  const outsideFrom = (status: string) =>
    declared !== undefined && declared.from !== "*" && !declared.from.includes(status);

  for (let i = 1; i < trace.steps.length; i++) {
    const action = trace.steps[i]?.action;
    const before = trace.steps[i - 1]?.state;
    if (action === undefined || before === undefined || action.transition !== name) continue;
    const status = before.status;
    switch (cause.category) {
      case "undeclared-transition":
        return true;
      case "from-state-unconstrained":
      case "from-state-mismatch":
        if (action.kind !== "write" && outsideFrom(status)) return true;
        break;
      case "non-atomic": {
        if (action.kind !== "write") break;
        const worker = trace.steps[i]?.state.workers.find((w) => w.id === action.worker);
        if (worker !== undefined && worker.observed !== status && outsideFrom(status)) return true;
        break;
      }
      default:
        return false;
    }
  }
  return false;
}
