import type { Severity } from "./finding";

export interface BuiltinProperty {
  severity: Severity;
  description: string;
}

/** Properties checked on every model without the author writing them. */
export const BUILTIN_PROPERTIES = {
  reachable: {
    severity: "warning",
    description: "Every declared state is reachable from the initial state.",
  },
  "no-stuck-states": {
    severity: "error",
    description:
      "No reachable non-terminal state is a genuine dead end (no transition leaves it). Dead ends caused only by exhausted invocation bounds are not reported.",
  },
  "effect-multiplicity": {
    severity: "error",
    description: "An exactly-once effect fires at most once per entity in every reachable state.",
  },
  "untrusted-guarded": {
    severity: "error",
    description: "Every transition performed by an untrusted actor has at least one guard.",
  },
  "webhook-idempotent": {
    severity: "error",
    description: "Every transition performed by a signed-webhook actor is marked idempotent.",
  },
} as const satisfies Record<string, BuiltinProperty>;

export type BuiltinPropertyId = keyof typeof BUILTIN_PROPERTIES;

export function ruleProperty(ruleName: string): string {
  return `rule:${ruleName}`;
}
