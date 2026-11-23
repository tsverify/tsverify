import type { Layout } from "./encode";

/** The spec transition a code-model transition comes from: `cancel~2`, `cancel->x` → `cancel`. */
function specName(name: string): string {
  return name.replace(/(~\d+|->.*)$/, "");
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
export function stateLimitHint(layout: Layout, maxStates: number): string {
  const transitions = layout.transitions;
  const invocations = transitions.reduce((n, t) => n + t.concurrency, 0);
  const bounds = [...new Set(transitions.map((t) => t.concurrency))].sort((a, b) => a - b);
  const bound = bounds.length === 1 ? `${bounds[0]}` : `${bounds[0]}–${bounds[bounds.length - 1]}`;
  const nonAtomic = transitions.filter((t) => !t.atomic).map((t) => t.name);
  const parts = [
    `${layout.states.length} states`,
    `${transitions.length} transitions at concurrency ${bound} (${invocations} invocations that can each run at any point${nonAtomic.length > 0 ? `; ${nonAtomic.length} non-atomic, ${list(nonAtomic)}, also pause between read and write` : ""})`,
  ];
  if (layout.effects.length > 0) {
    const caps = [...new Set(layout.effects.map((e) => e.cap))].sort((a, b) => a - b);
    const range = caps.length === 1 ? `0–${caps[0]}` : `0–${caps[0]} to 0–${caps[caps.length - 1]}`;
    parts.push(`${layout.effects.length} effect counters (${range} each)`);
  }
  // Keep the races that matter: a non-atomic transition's, else any one, as the example.
  const example = specName(nonAtomic[0] ?? transitions[0]?.name ?? "my_transition");
  return [
    `The explored states multiply: ${parts.join(" × ")}.`,
    "Lower the concurrency where invocations don't race, for every transition and then back up for the ones that do:",
    "  concurrency:",
    "    default: 1",
    `    max_parallel: { ${example}: 2 }`,
    `or raise the state limit (--max-states, now ${maxStates}).`,
  ].join("\n");
}
