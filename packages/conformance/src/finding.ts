import type {
  BehaviorModel,
  CodeSites,
  Finding,
  FindingCategory,
  Severity,
  SourceLocation,
  Transition,
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
 * several writes to `t.to` (`refund~2`). The common case keeps short, stable ids.
 */
export function pairingFinding(
  p: Pairing,
  input: Omit<FindingInput, "behavior" | "transition" | "specAt">,
): Finding {
  const parts = [input.subject, p.code.name === p.t.name ? undefined : p.code.name].filter(
    (s): s is string => s !== undefined,
  );
  return makeFinding({
    ...input,
    behavior: p.spec.name,
    transition: p.t.name,
    ...(parts.length === 0 ? {} : { subject: parts.join(":") }),
    ...(p.t.at === undefined ? {} : { specAt: p.t.at }),
  });
}

/** `["paid"]` → `paid`, `["a", "b"]` → `{a, b}`, `"*"` → `any state`. */
export function formatStates(states: string[] | "*"): string {
  if (states === "*") return "any state";
  if (states.length === 1) return states[0] as string;
  return `{${states.join(", ")}}`;
}
