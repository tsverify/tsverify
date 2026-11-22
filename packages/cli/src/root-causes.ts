import type { BehaviorModel, Finding, Trace } from "@tsv/ir";

/**
 * Root-cause links: `causedBy` on code-model checker findings (`implementation-property`) that a
 * conformance finding of the same run explains. Only the CLI sees both kinds, so it links them
 * after steps 3–5 of `tsv check` (see `code-conformance.ts`).
 *
 * The rule is deliberately conservative. A cause is linked only when the counterexample uses
 * the mismatch, i.e. some step of the trace is impossible under the spec for exactly the reason
 * the conformance finding gives. For a step whose action is by transition `t`, with `status` the
 * status just before that step and `from` the spec's `from` for `t`:
 *
 * | Conformance finding on `t`                          | Linked when the trace has a step that… |
 * |-----------------------------------------------------|----------------------------------------|
 * | `undeclared-transition` (an unlinked code transition) | is any action of `t`: the spec has no such transition at all |
 * | `from-state-unconstrained` / `from-state-mismatch`  | is an `atomic` or `read` of `t` with `status ∉ from`: the state check the spec asks for would have rejected it |
 * | `non-atomic`                                        | is a `write` of `t` with `status ∉ from` and `status ≠` the status that worker observed at its read: the state changed in the check-then-act gap, and an atomic `t` would have rejected it |
 *
 * `from: "*"` never links (no status is outside it), nor does a transition the spec doesn't
 * declare (other than through `undeclared-transition`). Other conformance categories (guards,
 * effects) are never linked: their effect on a trace can't be read off its steps. A finding may
 * have several causes; they keep the order of `findings`.
 */
export function linkRootCauses(findings: readonly Finding[], spec: BehaviorModel): Finding[] {
  const causes = findings.filter((f) => CAUSE_CATEGORIES.has(f.category));
  if (causes.length === 0) return [...findings];
  return findings.map((f) => {
    if (f.category !== "implementation-property" || f.trace === undefined) return f;
    const trace = f.trace;
    const linked = causes
      .filter((c) => c.behavior === f.behavior && explains(c, trace, spec))
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
]);

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
