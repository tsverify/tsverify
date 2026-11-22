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
  // generated tests (tsverify test)
  | "generated-test-failed"
  | "replay-confirmed"
  | "replay-disagrees"
  // analysis limits
  | "unanalyzable"
  /** `tsverify test` could not generate a test (missing fixtures, invocation shape, unsupported persistence). */
  | "not-generated";

/** Categories that mean "the input is invalid" rather than "a behavior bug was found". */
export const INPUT_ERROR_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "invalid-spec",
  "broken-link",
]);

export interface Finding {
  /**
   * Stable id for dedup and SARIF: `<category>:<behavior>:<property>[:<subject>]`, where the
   * subject disambiguates properties that can fire more than once (an effect, a state, a
   * transition), e.g. `spec-property:Order lifecycle:effect-multiplicity:stripe.refund`.
   * Input errors use `invalid-spec:<file>:<line>:<col>`.
   */
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
  /**
   * Ids of findings this one is a consequence of (same run). E.g. B3's implementation-property
   * double refund is caused by the `non-atomic` conformance finding on `refund`.
   */
  causedBy?: string[];
}
