import type { BehaviorModel } from "@tsv/ir";
import { compareStrings } from "./compare";

export interface PermissionCell {
  allowed: boolean;
  /** Transition `requires` plus the actor's implied `requires`, as canonical raw text, sorted. Empty when not allowed. */
  guards: string[];
}

export interface PermissionMatrix {
  /** Row keys: declared actors plus any actor only named in a `by`, sorted by name. */
  actors: string[];
  /** Column keys: transition names, sorted. */
  transitions: string[];
  /** `cells[actor][transition]`. */
  cells: Record<string, Record<string, PermissionCell>>;
  /** Actors with `trust: untrusted`, sorted. */
  untrusted: string[];
}

/** Who can perform which transition, and under which guards. */
export function permissionMatrix(model: BehaviorModel): PermissionMatrix {
  const transitions = [...model.transitions].sort((a, b) => compareStrings(a.name, b.name));
  const actorNames = new Set(Object.keys(model.actors));
  for (const t of transitions) for (const a of t.by) actorNames.add(a);
  const actors = [...actorNames].sort(compareStrings);

  const cells: Record<string, Record<string, PermissionCell>> = {};
  for (const actor of actors) {
    const row: Record<string, PermissionCell> = {};
    const implied = model.actors[actor]?.requires ?? [];
    for (const t of transitions) {
      const allowed = t.by.includes(actor);
      const guards = allowed
        ? [...new Set([...t.requires, ...implied].map((g) => g.raw))].sort(compareStrings)
        : [];
      row[t.name] = { allowed, guards };
    }
    cells[actor] = row;
  }

  const untrusted = actors.filter((a) => model.actors[a]?.trust === "untrusted");
  return { actors, transitions: transitions.map((t) => t.name), cells, untrusted };
}

/**
 * The matrix as a Markdown table. Untrusted actors are marked, and an allowed cell with no
 * guard on an untrusted row is flagged in bold, since anyone can perform that transition.
 */
export function permissionMatrixMarkdown(model: BehaviorModel): string {
  const m = permissionMatrix(model);
  const untrusted = new Set(m.untrusted);
  const row = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;

  const lines = [row(["Actor", ...m.transitions]), row(["---", ...m.transitions.map(() => "---")])];
  let flagged = false;
  for (const actor of m.actors) {
    const isUntrusted = untrusted.has(actor);
    const cells = m.transitions.map((t) => {
      const cell = m.cells[actor]?.[t];
      if (!cell?.allowed) return "—";
      if (cell.guards.length > 0) return `✓ ${cell.guards.join(", ")}`;
      if (!isUntrusted) return "✓";
      flagged = true;
      return "**✓ ⚠ unguarded**";
    });
    lines.push(row([isUntrusted ? `${actor} ⚠ untrusted` : actor, ...cells]));
  }

  lines.push("");
  lines.push(
    "✓ allowed, with the guards that must pass · — not allowed · ⚠ untrusted: its requests cannot be trusted",
  );
  if (flagged) {
    lines.push("");
    lines.push("**⚠ unguarded**: an untrusted actor can perform this transition with no guard.");
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
