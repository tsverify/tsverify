import {
  type BehaviorModel,
  compareStrings,
  type Finding,
  type GuardRef,
  type SourceLocation,
  type Transition,
} from "@tsv/ir";
import { type Pairing, pairingFinding } from "./finding";

interface RequiredGuard {
  guard: GuardRef;
  /** Where the requirement comes from, e.g. `refund.requires` or `actor admin`. */
  sources: string[];
}

/** `t.requires` ∪ the `requires` of every actor in `t.by`, keyed by `GuardRef.raw`, sorted. */
export function requiredGuards(spec: BehaviorModel, t: Transition): RequiredGuard[] {
  const byRaw = new Map<string, RequiredGuard>();
  const add = (guard: GuardRef, source: string) => {
    const entry = byRaw.get(guard.raw) ?? { guard, sources: [] };
    entry.sources.push(source);
    byRaw.set(guard.raw, entry);
  };
  for (const g of t.requires) add(g, `${t.name}.requires`);
  // An actor missing from `actors` is an invalid spec, reported by @tsv/spec; skip it here.
  for (const name of t.by)
    for (const g of spec.actors[name]?.requires ?? []) add(g, `actor ${name}`);
  return [...byRaw.values()].sort((a, b) => compareStrings(a.guard.raw, b.guard.raw));
}

function compareLocations(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/**
 * Every required guard must dominate the write, i.e. appear in the code transition's `requires`
 * (`ModelOrigin`: bound guards that dominate the write). `codeAt` is the earliest call of that
 * guard that does not dominate, or the write when the guard is never called.
 */
export function checkGuards(p: Pairing): Finding[] {
  const { spec, t, code, sites } = p;
  const dominating = new Set(code.requires.map((g) => g.raw));
  const findings: Finding[] = [];
  for (const { guard, sources } of requiredGuards(spec, t)) {
    if (dominating.has(guard.raw)) continue;
    const partial = sites.guards
      .filter((g) => g.guard === guard.raw && !g.dominates)
      .map((g) => g.at)
      .sort(compareLocations)[0];
    const binding = spec.bindings.guards[guard.raw];
    const call = binding === undefined ? `the ${guard.raw} guard` : binding.symbol;
    const how = partial === undefined ? "is never called" : "is called on some paths but not all";
    const entry = t.impl === undefined ? "the impl" : t.impl.symbol;
    findings.push(
      pairingFinding(p, {
        category: "guard-not-dominating",
        severity: "error",
        subject: guard.raw,
        message:
          `${t.name}: ${guard.raw} (${call}) ${how} before the write ` +
          `(required by ${sources.join(", ")}).`,
        hint: `Call ${call} on every path from ${entry} to the write, before any early return.`,
        codeAt: partial ?? sites.write,
      }),
    );
  }
  return findings;
}
