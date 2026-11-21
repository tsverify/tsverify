import { type Finding, type Rule, ruleProperty } from "@tsv/ir";
import { encodedAccess, STATUS } from "../encode";
import { type CompiledExpr, compileExpr } from "../eval";
import { type CheckContext, type PropertyChecker, propertyFinding } from "./context";

interface EventuallyWatch {
  rule: Rule;
  holds: CompiledExpr<Uint16Array>;
  first: number;
}

export interface LivenessChecker extends PropertyChecker {
  /** Deadlocks caused only by the invocation budget. Never reported as findings. */
  readonly boundLimitedDeadlocks: number;
}

/**
 * `eventually` rules (AG EF) and the `no-stuck-states` built-in.
 *
 * The state graph is a finite DAG (see `semantics.ts`), so every path ends in a deadlock and
 * `AG EF p` fails exactly when some deadlock violates `p`. Budget-limited deadlocks are artefacts
 * of the bound (one more invocation would make progress), so only genuine deadlocks count.
 * Deadlocks are reported as they are expanded, in BFS order, so the first one is the shallowest.
 */
export function liveness(ctx: CheckContext): LivenessChecker {
  const { layout } = ctx;
  const access = encodedAccess(layout);
  const rules: EventuallyWatch[] = ctx.model.rules
    .filter((r) => r.kind === "eventually")
    .map((rule) => ({ rule, holds: compileExpr(rule.expr, access), first: -1 }));
  let stuck = -1;
  let boundLimited = 0;

  return {
    get boundLimitedDeadlocks() {
      return boundLimited;
    },

    onDeadlock(id, s, budgetLimited) {
      if (budgetLimited) {
        boundLimited++;
        return;
      }
      // A deadlock has no `checked` workers left (a pending write is always enabled), so a
      // genuine deadlock in a non-terminal status is stuck for good.
      if (stuck === -1 && layout.terminal[s[STATUS] as number] === 0) stuck = id;
      for (const w of rules) if (w.first === -1 && !w.holds(s)) w.first = id;
    },

    findings({ trace }) {
      const out: Finding[] = [];
      const entity = ctx.model.entity;
      if (stuck !== -1) {
        const property = "no-stuck-states";
        const t = trace(stuck, property, "liveness");
        const status = t.steps[t.steps.length - 1]?.state.status ?? "?";
        out.push(
          propertyFinding(ctx, property, undefined, {
            severity: "error",
            message: `${entity.name} can get stuck in non-terminal status \`${status}\`: no transition leaves it and no terminal state is reachable.`,
            ...(entity.at && { specAt: entity.at }),
            trace: t,
            hint: `add a transition out of \`${status}\`, or mark it terminal`,
          }),
        );
      }
      for (const { rule, first } of rules) {
        if (first === -1) continue;
        const property = ruleProperty(rule.name);
        const t = trace(first, property, "liveness");
        const status = t.steps[t.steps.length - 1]?.state.status ?? "?";
        out.push(
          propertyFinding(ctx, property, undefined, {
            severity: "error",
            message: `Rule "${rule.name}" (eventually: ${rule.source}) is violated: ${entity.name} can end in status \`${status}\` where it never holds.`,
            ...(rule.at && { specAt: rule.at }),
            trace: t,
          }),
        );
      }
      return out;
    },
  };
}
