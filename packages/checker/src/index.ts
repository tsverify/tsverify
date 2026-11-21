import type { BehaviorModel, Finding } from "@tsv/ir";
import { buildLayout, initialState } from "./encode";
import { explore } from "./explore";
import { checkContext, type PropertyChecker } from "./properties/context";
import { invariants } from "./properties/invariants";
import { lint } from "./properties/lint";
import { liveness } from "./properties/liveness";
import { reachability } from "./properties/reachability";
import { buildActions } from "./semantics";
import { buildTrace } from "./trace";

export interface CheckOptions {
  /** Stop after storing this many distinct states. Default 1_000_000. */
  maxStates?: number;
}

export interface CheckStats {
  /** Distinct (symmetry-reduced) states stored. */
  states: number;
  /** Explored transitions between states, including those into already-seen states. */
  edges: number;
  durationMs: number;
  /** false when `maxStates` stopped exploration early. */
  complete: boolean;
  /** Deadlocks caused only by the concurrency bound; never reported as findings. */
  boundLimitedDeadlocks: number;
}

export interface CheckResult {
  findings: Finding[];
  stats: CheckStats;
}

export const DEFAULT_MAX_STATES = 1_000_000;

/**
 * Model-checks one entity model: structural lints, then a BFS over every reachable state that
 * evaluates rules and built-in properties. Works the same on spec and code models; only the
 * finding category (and which built-ins apply) differs. Semantics: see `semantics.ts`.
 *
 * Findings are ordered: lints, invariants (rules in model order, then effects by name), liveness,
 * reachability, analysis limits.
 */
export function check(model: BehaviorModel, options: CheckOptions = {}): CheckResult {
  const started = performance.now();
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const layout = buildLayout(model);
  const actions = buildActions(layout);
  const ctx = checkContext(model, layout);

  const live = liveness(ctx);
  const checkers: PropertyChecker[] = [invariants(ctx), live, reachability(ctx)];
  const onState = checkers.flatMap((c) => (c.onState ? [c.onState.bind(c)] : []));
  const onDeadlock = checkers.flatMap((c) => (c.onDeadlock ? [c.onDeadlock.bind(c)] : []));

  const result = explore(layout, actions, initialState(layout), maxStates, {
    onState(id, s) {
      for (const f of onState) f(id, s);
    },
    onDeadlock(id, s, budgetLimited) {
      for (const f of onDeadlock) f(id, s, budgetLimited);
    },
  });

  const input = {
    complete: result.complete,
    trace: (stateId: number, property: string, kind: "invariant" | "liveness") =>
      buildTrace(ctx, actions, result.store, stateId, property, kind),
  };
  const findings: Finding[] = [...lint(ctx), ...checkers.flatMap((c) => c.findings(input))];
  if (!result.complete) {
    findings.push({
      id: `unanalyzable:${model.name}:state-limit`,
      category: "unanalyzable",
      severity: "warning",
      message: `State limit reached: explored ${result.store.size} states (maxStates: ${maxStates}) without finishing; results are incomplete.`,
      behavior: model.name,
      hint: "raise maxStates, or lower concurrency for transitions that don't race",
    });
  }

  return {
    findings,
    stats: {
      states: result.store.size,
      edges: result.edges,
      durationMs: performance.now() - started,
      complete: result.complete,
      boundLimitedDeadlocks: live.boundLimitedDeadlocks,
    },
  };
}
