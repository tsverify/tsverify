import { type BehaviorModel, compareStrings, type Finding } from "@tsverify/ir";
import { checkAtomicity } from "./atomicity";
import { checkEffects } from "./effects";
import type { Pairing } from "./finding";
import { checkFromStates } from "./from-states";
import { checkGuards } from "./guards";
import { checkLinked, checkNoImpl, checkUnlinked, linkTransitions } from "./transitions";

/** Per-pairing rules, in no particular order (findings are sorted afterwards). */
const PAIRING_RULES: ((p: Pairing) => Finding[])[] = [
  checkFromStates,
  checkGuards,
  checkEffects,
  checkAtomicity,
];

/**
 * Compares a spec model with the as-implemented code model the extractor built from it and
 * reports every mismatch. Pure and deterministic: findings are ordered by spec
 * transition name, then category, then id; findings for unlinked code writes come last, by name.
 *
 * Throws (programmer error) when the origins are not `spec` / `code`, when the entities differ,
 * or when the code model does not follow the conventions documented on `ModelOrigin`.
 */
export function compare(spec: BehaviorModel, code: BehaviorModel): Finding[] {
  if (spec.origin !== "spec") {
    throw new Error(
      `conformance: first argument must be a spec model, got origin "${spec.origin}"`,
    );
  }
  if (code.origin !== "code") {
    throw new Error(
      `conformance: second argument must be a code model, got origin "${code.origin}"`,
    );
  }
  if (spec.entity.name !== code.entity.name) {
    throw new Error(
      `conformance: entity mismatch: spec "${spec.entity.name}" vs. code "${code.entity.name}"`,
    );
  }

  const { linked, unlinked } = linkTransitions(spec, code);
  const findings: Finding[] = [];
  for (const t of spec.transitions) {
    if (t.impl === undefined) {
      findings.push(checkNoImpl(spec, t));
      continue;
    }
    const result = checkLinked(spec, t, linked.get(t.name) ?? [], code.implAt?.[t.name]);
    findings.push(...result.findings);
    for (const p of result.pairings) {
      for (const rule of PAIRING_RULES) findings.push(...rule(p));
    }
  }
  findings.sort(
    (a, b) =>
      compareStrings(a.transition ?? "", b.transition ?? "") ||
      compareStrings(a.category, b.category) ||
      compareStrings(a.id, b.id),
  );
  return [...findings, ...unlinked.map((c) => checkUnlinked(spec, c))];
}
