/**
 * Behavioral semantics of an entity model. This header is the reference for what the checker
 * explores.
 *
 * State
 *   `status`, a count per effect, and for every transition `t` its `concurrency[t]` workers
 *   (invocations), each `idle`, `checked` or `done`. Effects are
 *   those declared on transitions; an effect named only in a rule always counts 0.
 *
 * Initial state
 *   `status = entity.initial`, every effect count 0, every worker idle.
 *
 * Actions (each one moves exactly one worker)
 *   atomic t      enabled iff an idle worker of t exists and (`from = "*"` or `status ∈ from`).
 *                 Sets `status := to`, increments each declared effect, the worker becomes done.
 *   read t        (non-atomic t) enabled iff an idle worker of t exists and `status ∈ from`
 *                 (or `"*"`). The worker becomes checked (traces record `observed = status`).
 *   write t       (non-atomic t) enabled iff a checked worker of t exists. Sets `status := to`
 *                 and increments the effects WITHOUT re-checking `from`: this is the
 *                 check-then-act gap. The worker becomes done.
 *   A disabled attempt is not an action: a rejected check is a no-op that does not consume the
 *   worker, so the `rejected` worker phase never occurs.
 *
 * Duplicate delivery
 *   For `idempotent: true` transitions, invocation #2 and later are redeliveries of the same
 *   event and are marked `duplicate: true` in traces. Their semantics are otherwise identical.
 *
 * Graph shape
 *   Every action moves a worker strictly forward (idle → checked → done, or idle → done), so the
 *   state graph is a finite DAG and every path ends in a deadlock (a state with no action).
 *
 * Deadlocks
 *   A deadlock is budget-limited if some transition has `status ∈ from` (only the exhausted
 *   invocation budget stops progress) and genuine otherwise. A deadlock never has checked
 *   workers, since a pending write is always enabled.
 *
 * Abstraction (exact for every property checked)
 *   - Symmetry: workers of one transition in the same phase are stored as a count
 *     (`symmetry.ts`). A checked worker's observed status is not part of the state: no action
 *     or property reads it, so it is reconstructed when a trace is built (`trace.ts`).
 *   - Effect counts saturate at `max(2, 1 + largest constant compared against the effect in any
 *     rule)`; comparisons against those constants and the `> 1` multiplicity check cannot tell
 *     a saturated count from the true one. Traces replay the actions, so they show true counts.
 */
import { type Layout, STATUS, type TransitionCode } from "./encode";

export type ActionKind = "atomic" | "read" | "write";

export interface Action {
  /** Position in the action table; stored as the parent edge label. */
  index: number;
  transition: TransitionCode;
  kind: ActionKind;
  /** For `write`: the checked field. For `atomic`/`read`: the idle field. */
  field: number;
}

/**
 * Every action of the model, in a fixed order: transitions in model order; per transition
 * `atomic`, or `read` followed by `write`.
 */
export function buildActions(layout: Layout): Action[] {
  const out: Action[] = [];
  for (const t of layout.transitions) {
    if (t.concurrency === 0) continue;
    if (t.atomic) {
      out.push({ index: out.length, transition: t, kind: "atomic", field: t.workers.idle });
      continue;
    }
    out.push({ index: out.length, transition: t, kind: "read", field: t.workers.idle });
    out.push({ index: out.length, transition: t, kind: "write", field: t.workers.checked });
  }
  return out;
}

export function isEnabled(action: Action, s: Uint16Array): boolean {
  if (s[action.field] === 0) return false;
  if (action.kind === "write") return true;
  return action.transition.enabledFrom[s[STATUS] as number] === 1;
}

/** Applies an enabled action to `s` in place. */
export function applyAction(action: Action, s: Uint16Array): void {
  const t = action.transition;
  s[action.field] = (s[action.field] as number) - 1;
  if (action.kind === "read") {
    const checked = t.workers.checked;
    s[checked] = (s[checked] as number) + 1;
    return;
  }
  s[STATUS] = t.to;
  const fields = t.effectFields;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as number;
    const count = s[f] as number;
    if (count < (t.effectCaps[i] as number)) s[f] = count + 1;
  }
}

/** For a deadlock: true when some transition could still fire if it had invocations left. */
export function isBudgetLimited(layout: Layout, s: Uint16Array): boolean {
  const status = s[STATUS] as number;
  return layout.transitions.some((t) => t.enabledFrom[status] === 1);
}
