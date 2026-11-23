import type { BehaviorModel } from "@tsverify/ir";
import type { Layout } from "./encode";

/**
 * The spec transition a model transition stands for: itself in a spec model; in a code model the
 * spec transition whose impl reaches the write (`sites.specTransition`: `cancel` for `cancel~2`
 * or `cancel->x`), itself for one copied from the spec (no `sites`), and undefined for a write no
 * spec transition reaches.
 */
function specNameOf(model: BehaviorModel, name: string): string | undefined {
  if (model.origin !== "code") return name;
  const t = model.transitions.find((x) => x.name === name);
  // Without sites: a spec transition taken as specified (no impl, or a write tsverify can't read).
  return t?.sites === undefined ? name : t.sites.specTransition;
}

/** `a, b and c` (at most `max` names, then `and N more`). */
function list(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * The hint of the state-limit warning: what makes this model's search large, and the spec
 * syntax that makes it smaller. The explored states multiply (`semantics.ts`): the status, every
 * transition's invocations (each idle or done, and for a non-atomic one also between its read and
 * its write) and every effect counter (0 up to its cap).
 */
export function stateLimitHint(layout: Layout, maxStates: number, model: BehaviorModel): string {
  const transitions = layout.transitions;
  const invocations = transitions.reduce((n, t) => n + t.concurrency, 0);
  const bounds = [...new Set(transitions.map((t) => t.concurrency))].sort((a, b) => a - b);
  const bound = bounds.length === 1 ? `${bounds[0]}` : `${bounds[0]}–${bounds[bounds.length - 1]}`;
  // Named as the spec names them: a code model's writes by the spec transition they serve.
  const named = (ts: typeof transitions) => [
    ...new Set(ts.flatMap((t) => specNameOf(model, t.name) ?? [])),
  ];
  const nonAtomicWrites = transitions.filter((t) => !t.atomic);
  const nonAtomic = named(nonAtomicWrites);
  const outside = nonAtomicWrites.filter((t) => specNameOf(model, t.name) === undefined).length;
  const whose = [
    ...(nonAtomic.length > 0 ? [list(nonAtomic)] : []),
    ...(outside > 0 ? [`${outside} no spec transition reaches`] : []),
  ].join("; ");
  const nonAtomicText =
    nonAtomicWrites.length === 0
      ? ""
      : model.origin === "code"
        ? `; ${nonAtomicWrites.length} non-atomic (writes of ${whose}), also pause between read and write`
        : `; ${nonAtomicWrites.length} non-atomic, ${whose}, also pause between read and write`;
  const what =
    model.origin === "code"
      ? `${transitions.length} writes of ${named(transitions).length} spec transitions`
      : `${transitions.length} transitions`;
  const parts = [
    `${layout.states.length} states`,
    `${what} at concurrency ${bound} (${invocations} invocations that can each run at any point${nonAtomicText})`,
  ];
  if (layout.effects.length > 0) {
    const caps = [...new Set(layout.effects.map((e) => e.cap))].sort((a, b) => a - b);
    const range = caps.length === 1 ? `0–${caps[0]}` : `0–${caps[0]} to 0–${caps[caps.length - 1]}`;
    parts.push(`${layout.effects.length} effect counters (${range} each)`);
  }
  // Keep the races that matter: a non-atomic transition's, else any one, as the example.
  const example = nonAtomic[0] ?? named(transitions)[0] ?? "my_transition";
  return [
    `The explored states multiply: ${parts.join(" × ")}.`,
    "Lower the concurrency where invocations don't race, for every transition and then back up for the ones that do:",
    "  concurrency:",
    "    default: 1",
    `    max_parallel: { ${example}: 2 }`,
    `or raise the state limit (--max-states, now ${maxStates}).`,
  ].join("\n");
}
