import { type BehaviorModel, compareStrings, type Finding } from "@tsverify/ir";
import { checkAtomicity } from "./atomicity";
import { checkEffects } from "./effects";
import type { Pairing } from "./finding";
import { checkFromStates, checkMissingFromStates } from "./from-states";
import { checkGuards } from "./guards";
import { checkLinked, checkNoImpl, checkUnlinked, linkTransitions } from "./transitions";

export { UNCONFIRMED_SUBJECT } from "./transitions";

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
    const result = checkLinked(
      spec,
      t,
      linked.get(t.name) ?? [],
      code.implAt?.[t.name],
      code.unreadWrites?.[t.name],
    );
    findings.push(...result.findings);
    findings.push(...checkMissingFromStates(result.pairings));
    for (const pairing of result.pairings) {
      const p = code.uncalledClients
        ? { ...pairing, uncalledClients: code.uncalledClients }
        : pairing;
      for (const rule of PAIRING_RULES) findings.push(...rule(p));
    }
  }
  findings.sort(
    (a, b) =>
      compareStrings(a.transition ?? "", b.transition ?? "") ||
      compareStrings(a.category, b.category) ||
      compareStrings(a.id, b.id),
  );
  return [...mergeRepeats(findings), ...unlinked.map((c) => checkUnlinked(spec, c))];
}

/**
 * One finding per repeated message. A transition whose impl reaches several writes of its `to`
 * (`t`, `t~2`, …) is checked once per write, and an undeclared effect those paths share is the
 * same finding each time: it is kept once (the first by id, the canonical one), and the other
 * places it is called from, when they differ, are listed in its message. Findings that are
 * identical apart from their id are kept once too.
 */
function mergeRepeats(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  const kept = new Map<string, { finding: Finding; also: string[] }>();
  const where = (f: Finding) =>
    f.codeAt === undefined ? "" : `${f.codeAt.file}:${f.codeAt.line}:${f.codeAt.column}`;
  for (const f of findings) {
    const merge = f.category === "undeclared-effect";
    const key = [f.category, f.transition ?? "", f.message, merge ? "" : where(f)].join("\u0000");
    const first = kept.get(key);
    if (first === undefined) {
      kept.set(key, { finding: f, also: [] });
      out.push(f);
      continue;
    }
    const at = f.codeAt && `${f.codeAt.file}:${f.codeAt.line}`;
    const firstAt =
      first.finding.codeAt && `${first.finding.codeAt.file}:${first.finding.codeAt.line}`;
    if (at !== undefined && at !== firstAt && !first.also.includes(at)) first.also.push(at);
  }
  for (const { finding, also } of kept.values()) {
    if (also.length === 0) continue;
    finding.message = `${finding.message.replace(/\.$/, "")} (also called at ${also.join(", ")}).`;
  }
  return out;
}
