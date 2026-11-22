import type { BehaviorModel, Finding, ModelOrigin, SourceLocation } from "@tsverify/ir";

export interface GeneratedFile {
  /** Relative to `outDir`, `/`-separated. */
  path: string;
  content: string;
}

export interface GenerateInput {
  /** The spec model; `file` and every location relative to the project root. */
  spec: BehaviorModel;
  /** The extracted code model of the same spec (locations relative to the project root). */
  code: BehaviorModel;
  /** Findings of `tsv check` for this spec; those with a `trace` become replay tests. */
  findings: Finding[];
  /** Project-relative directory the files are written to, e.g. `.tsv/generated/order-lifecycle`. */
  outDir: string;
}

export type GeneratedTestKind = "path" | "forbidden" | "guard" | "replay";

/**
 * One generated `test(…)`, so `tsv test` can map a vitest result back onto the spec and the code.
 * Matched by `file` + `name` (names are unique within a file).
 */
export interface GeneratedTest {
  /** Test file, relative to `outDir`. */
  file: string;
  name: string;
  kind: GeneratedTestKind;
  /** Spec transition under test (path / forbidden / guard), or the source finding's transition. */
  transition?: string;
  /** State the entity is seeded in (path / forbidden / guard). */
  from?: string;
  /** Actor the impl is called as, when it takes one. */
  actor?: string;
  /** Replay: id of the finding whose counterexample is replayed. */
  finding?: string;
  /** Replay: the violated property (`effect-multiplicity`, `rule:<name>`, …). */
  property?: string;
  /** Replay: which model the counterexample came from. */
  model?: ModelOrigin;
  /** Replay: false when the property cannot be evaluated in code terms (the test only replays). */
  evaluable?: boolean;
  specAt?: SourceLocation;
  /** The impl's state write (path / forbidden / guard) or the source finding's code location. */
  codeAt?: SourceLocation;
}

export interface GenerateResult {
  /** Test files and their JSON sidecars, in a stable order. */
  files: GeneratedFile[];
  /** `info` findings explaining what was not generated, and why. */
  skipped: Finding[];
  /** Every generated test, in file order. */
  tests: GeneratedTest[];
}
