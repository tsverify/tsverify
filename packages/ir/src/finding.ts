import type { SourceLocation } from "./location";
import type { Trace } from "./trace";

export type Severity = "error" | "warning" | "info";

export type FindingCategory =
  // invalid input → exit code 2
  | "invalid-spec"
  | "broken-link"
  // model checking
  | "spec-property"
  | "implementation-property"
  // conformance (spec vs extracted code)
  | "undeclared-transition"
  | "missing-transition"
  | "from-state-mismatch"
  | "from-state-unconstrained"
  | "guard-not-dominating"
  | "undeclared-effect"
  | "missing-effect"
  | "non-atomic"
  // replay
  | "replay-confirmed"
  | "replay-disagrees"
  // analysis limits
  | "unanalyzable";

/** Categories that mean "the input is invalid" rather than "a behavior bug was found". */
export const INPUT_ERROR_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "invalid-spec",
  "broken-link",
]);

export interface Finding {
  /** Stable id for dedup and SARIF, e.g. `spec-property:Order lifecycle:refund`. */
  id: string;
  category: FindingCategory;
  severity: Severity;
  message: string;
  /** Behavior (model) name the finding belongs to. */
  behavior?: string;
  transition?: string;
  /** Built-in property id or `rule:<name>`. */
  property?: string;
  specAt?: SourceLocation;
  codeAt?: SourceLocation;
  trace?: Trace;
  hint?: string;
}
