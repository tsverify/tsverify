import { pathToFileURL } from "node:url";
import type { Finding, FindingCategory, Severity, SourceLocation } from "@tsv/ir";
import { traceToText } from "@tsv/render";
import pkg from "../../package.json" with { type: "json" };
import type { Report } from "../report";

/**
 * `--format sarif`: SARIF 2.1.0 for GitHub code scanning and other SARIF viewers. One run, tool
 * driver `tsv`, one rule per finding category. Deterministic for a given cwd: no timings, rules
 * in a fixed order, results in report order.
 */

/** One-line description per category: the SARIF rule's `shortDescription`. */
export const CATEGORY_DESCRIPTIONS: Record<FindingCategory, string> = {
  "invalid-spec": "The behavior file does not parse or validate.",
  "broken-link": "An impl, client or guard binding in the spec does not resolve to code.",
  "spec-property":
    "The behavior spec itself violates a property: model checking found a counterexample.",
  "implementation-property":
    "The code, as extracted, violates a property of its spec: model checking the code model found a counterexample.",
  "undeclared-transition": "The code changes the state in a way the spec does not declare.",
  "missing-transition": "A spec transition's impl never writes the transition's target state.",
  "from-state-mismatch": "The code allows a transition from other states than the spec does.",
  "from-state-unconstrained": "The code writes the state without checking the current state.",
  "guard-not-dominating":
    "A guard the spec requires does not run on every path to the state write.",
  "undeclared-effect": "The code performs an effect the transition does not declare.",
  "missing-effect": "An effect the transition declares is never performed by the code.",
  "non-atomic":
    "The spec says atomic, but the code's state check and write are not one atomic step.",
  "generated-test-failed": "A test generated from the spec failed against the code.",
  "replay-confirmed": "Replaying a counterexample against the real code reproduced the violation.",
  "replay-disagrees": "Replaying a counterexample against the real code did not reproduce it.",
  unanalyzable: "tsv could not analyze this part of the code or spec.",
  "not-generated": "tsv test could not generate a test for this transition or actor.",
};

const RULE_IDS = Object.keys(CATEGORY_DESCRIPTIONS) as FindingCategory[];
const RULE_INDEX = new Map(RULE_IDS.map((id, i) => [id, i]));

const LEVEL: Record<Severity, SarifLevel> = { error: "error", warning: "warning", info: "note" };

/** The base every result URI is relative to: the cwd tsv ran in. */
export const SRCROOT = "%SRCROOT%";
/** `partialFingerprints` key: finding ids are stable across runs (see `Finding.id`). */
export const FINGERPRINT_KEY = "tsvFindingId/v1";

export type SarifLevel = "error" | "warning" | "note";

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: [SarifRun];
}

export interface SarifRun {
  tool: {
    driver: { name: "tsv"; version: string; rules: SarifRule[] };
  };
  originalUriBaseIds: Record<string, { uri: string }>;
  columnKind: "utf16CodeUnits";
  results: SarifResult[];
}

export interface SarifRule {
  id: FindingCategory;
  name: string;
  shortDescription: { text: string };
}

export interface SarifLocation {
  id?: number;
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number; startColumn?: number; endLine?: number; endColumn?: number };
  };
  message?: { text: string };
}

export interface SarifResult {
  ruleId: FindingCategory;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: [SarifLocation];
  relatedLocations?: SarifLocation[];
  partialFingerprints: Record<string, string>;
  properties: SarifProperties;
}

/** tsv-specific data per result. Only the keys that apply are present. */
export interface SarifProperties {
  behavior?: string;
  transition?: string;
  property?: string;
  /** The finding's spec says `enforced: true`. */
  enforced?: true;
  /** Ids of the findings this one is a consequence of (their `partialFingerprints`). */
  causedBy?: string[];
  /** The counterexample, one `traceToText` line per step. */
  trace?: { model: string; property: string; kind: string; steps: string[] };
}

export function toSarif(report: Report, cwd: string): SarifLog {
  const results = report.specs.flatMap((spec) =>
    spec.findings.map((f) => toResult(f, spec.file, spec.enforced === true)),
  );
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "tsv",
            version: pkg.version,
            rules: RULE_IDS.map((id) => ({
              id,
              name: ruleName(id),
              shortDescription: { text: CATEGORY_DESCRIPTIONS[id] },
            })),
          },
        },
        originalUriBaseIds: {
          [SRCROOT]: { uri: `${pathToFileURL(cwd).href.replace(/\/$/, "")}/` },
        },
        columnKind: "utf16CodeUnits",
        results,
      },
    ],
  };
}

export function formatSarif(report: Report, cwd: string): string {
  return `${JSON.stringify(toSarif(report, cwd), null, 2)}\n`;
}

/**
 * The primary location is where the fix most likely goes: the code when there is a code site,
 * else the spec; the other one is a related location. A finding with neither points at its spec
 * file, since code scanning needs a location for every result.
 */
function toResult(f: Finding, specFile: string, enforced: boolean): SarifResult {
  const primary = f.codeAt ?? f.specAt ?? { file: specFile, line: 1, column: 1 };
  const related =
    f.codeAt && f.specAt
      ? [{ id: 1, ...location(f.specAt), message: { text: "Behavior spec" } }]
      : [];
  const properties: SarifProperties = {};
  if (f.behavior !== undefined) properties.behavior = f.behavior;
  if (f.transition !== undefined) properties.transition = f.transition;
  if (f.property !== undefined) properties.property = f.property;
  if (enforced) properties.enforced = true;
  if (f.causedBy !== undefined && f.causedBy.length > 0) properties.causedBy = [...f.causedBy];
  if (f.trace) {
    const { model, property, kind } = f.trace;
    properties.trace = { model, property, kind, steps: traceToText(f.trace).trimEnd().split("\n") };
  }
  return {
    ruleId: f.category,
    ruleIndex: RULE_INDEX.get(f.category) ?? 0,
    level: LEVEL[f.severity],
    message: { text: f.hint === undefined ? f.message : `${f.message}\nHint: ${f.hint}` },
    locations: [location(primary)],
    ...(related.length > 0 && { relatedLocations: related }),
    partialFingerprints: { [FINGERPRINT_KEY]: f.id },
    properties,
  };
}

function location(at: SourceLocation): SarifLocation {
  const region: SarifLocation["physicalLocation"]["region"] = {
    startLine: at.line,
    startColumn: at.column,
  };
  if (at.endLine !== undefined) region.endLine = at.endLine;
  if (at.endColumn !== undefined) region.endColumn = at.endColumn;
  return {
    physicalLocation: {
      artifactLocation: { uri: fileUri(at.file), uriBaseId: SRCROOT },
      region,
    },
  };
}

/** A relative URI reference for a `/`-separated path relative to the cwd. */
function fileUri(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

/** `non-atomic` → `NonAtomic`. */
function ruleName(id: string): string {
  return id.replace(/(^|-)([a-z])/g, (_, _dash: string, c: string) => c.toUpperCase());
}
