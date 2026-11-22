import {
  type BehaviorModel,
  type CodeSites,
  compareStrings,
  type Finding,
  type FindingCategory,
  type Severity,
  type SourceLocation,
  type Transition,
} from "@tsv/ir";

/**
 * One spec transition `t` paired with the linked code transition `code` that writes `t.to`
 * (its "primary" write). Every per-transition rule (from-states, guards, effects, atomicity)
 * runs on one of these.
 */
export interface Pairing {
  spec: BehaviorModel;
  t: Transition;
  code: Transition;
  sites: CodeSites;
}

export interface FindingInput {
  category: FindingCategory;
  severity: Severity;
  behavior: string;
  /** Spec transition name, or the code transition name for unlinked writes. */
  transition: string;
  /** Disambiguates a property that can fire more than once (a guard, an effect, a code write). */
  subject?: string;
  message: string;
  hint: string;
  specAt?: SourceLocation;
  codeAt?: SourceLocation;
}

/** Builds a finding with the id `<category>:<behavior>:<transition>[:<subject>]`. Omits absent fields. */
export function makeFinding(input: FindingInput): Finding {
  const { category, severity, behavior, transition, subject, message, hint, specAt, codeAt } =
    input;
  const id = [category, behavior, transition, ...(subject === undefined ? [] : [subject])].join(
    ":",
  );
  return {
    id,
    category,
    severity,
    message,
    behavior,
    transition,
    ...(specAt === undefined ? {} : { specAt }),
    ...(codeAt === undefined ? {} : { codeAt }),
    hint,
  };
}

/**
 * A finding about pairing `p`. The id subject is `subject`, followed by the code transition name
 * when that write is not the canonical one (named exactly `t.name`), i.e. when the impl has
 * several writes to `t.to` (`refund~2`). The common case keeps short, stable ids. `specAt` is
 * the most precise spec location the rule has (a `requires` item, an effect), else `t.at`.
 */
export function pairingFinding(
  p: Pairing,
  input: Omit<FindingInput, "behavior" | "transition">,
): Finding {
  const specAt = input.specAt ?? p.t.at;
  const parts = [input.subject, p.code.name === p.t.name ? undefined : p.code.name].filter(
    (s): s is string => s !== undefined,
  );
  return makeFinding({
    ...input,
    behavior: p.spec.name,
    transition: p.t.name,
    ...(parts.length === 0 ? {} : { subject: parts.join(":") }),
    ...(specAt === undefined ? {} : { specAt }),
  });
}

/** `["paid"]` → `paid`, `["a", "b"]` → `{a, b}`, `"*"` → `any state`. */
export function formatStates(states: string[] | "*"): string {
  if (states === "*") return "any state";
  if (states.length === 1) return states[0] as string;
  return `{${states.join(", ")}}`;
}

/** The first location in file, line, column order (for a deterministic `codeAt`). */
export function earliest(locations: SourceLocation[]): SourceLocation | undefined {
  return [...locations].sort(
    (a, b) => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column,
  )[0];
}
