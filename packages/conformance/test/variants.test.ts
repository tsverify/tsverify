import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compare } from "@tsverify/conformance";
import type { Finding, FindingCategory } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { MUTATION_CASES, variantCase } from "./code-model";

/**
 * Drives the seeded-bug variants of `examples/orders-app` from their `variant.json` manifests,
 * so the expectations here cannot drift from the e2e suite's. The code models are hand-built
 * mirrors of each overlay (see `code-model.ts`); the real extractor is tested end to end.
 */

const VARIANTS_DIR = fileURLToPath(
  new URL("../../../examples/orders-app/variants/", import.meta.url),
);

/** A `variant.json` `expected` entry (validated by `parseManifest` in the app's tests). */
interface Expected {
  category: FindingCategory;
  transition?: string;
  property?: string;
  subject?: string;
  file?: string;
}

/** Categories `compare` can report. */
const CONFORMANCE = new Set<FindingCategory>([
  "undeclared-transition",
  "missing-transition",
  "from-state-mismatch",
  "from-state-unconstrained",
  "guard-not-dominating",
  "undeclared-effect",
  "missing-effect",
  "non-atomic",
  "unanalyzable",
]);

/** Categories the model checker reports; `expected` entries with these are not ours. */
const CHECKER = new Set<FindingCategory>(["spec-property", "implementation-property"]);

/**
 * Conformance findings beyond `expected` that the variants README calls knock-on effects of a
 * bug. The README's knock-ons (B1, B4 paying twice) are checker findings, so none apply here.
 */
const KNOCK_ON: Record<string, Expected[]> = {};

const variantIds = readdirSync(VARIANTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function manifest(id: string): { id: string; expected: Expected[] } {
  return JSON.parse(readFileSync(`${VARIANTS_DIR}${id}/variant.json`, "utf8"));
}

function matches(f: Finding, e: Expected): boolean {
  return (
    f.category === e.category &&
    (e.transition === undefined || f.transition === e.transition) &&
    (e.property === undefined || f.property === e.property) &&
    (e.subject === undefined || f.id.endsWith(`:${e.subject}`)) &&
    (e.file === undefined || f.codeAt?.file === e.file)
  );
}

function findingsFor(id: string): Finding[] {
  const c = variantCase(id);
  if (c === undefined) throw new Error(`add a case for variant ${id} to VARIANT_CASES`);
  return compare(c.spec, c.code);
}

describe("seeded-bug variants", () => {
  it("finds every variant directory", () => {
    expect(variantIds).toEqual([
      "b1-reopen",
      "b2-guard-bypass",
      "b3-refund-race",
      "b4-webhook-dup",
      "b5-undeclared-effect",
      "b6-spec-race",
    ]);
  });

  it.each(variantIds)("%s: reports exactly its expected conformance findings", (id) => {
    const { id: manifestId, expected } = manifest(id);
    expect(manifestId).toBe(id);
    for (const e of expected) {
      expect(CONFORMANCE.has(e.category) || CHECKER.has(e.category), e.category).toBe(true);
    }
    const ours = [...expected.filter((e) => CONFORMANCE.has(e.category)), ...(KNOCK_ON[id] ?? [])];
    const findings = findingsFor(id);
    expect(findings.map((f) => f.category).sort()).toEqual(ours.map((e) => e.category).sort());
    for (const e of ours) {
      expect(
        findings.some((f) => matches(f, e)),
        `${id}: no finding matches ${JSON.stringify(e)}`,
      ).toBe(true);
    }
  });

  it("keeps messages and hints stable (golden)", async () => {
    const all = Object.fromEntries(variantIds.map((id) => [id, findingsFor(id)]));
    await expect(`${JSON.stringify(all, null, 2)}\n`).toMatchFileSnapshot(
      "__golden__/variants.findings.json",
    );
  });

  it("keeps the messages and hints of the synthetic mutations stable (golden)", async () => {
    const all = Object.fromEntries(
      Object.entries(MUTATION_CASES).map(([name, make]) => {
        const { spec, code } = make();
        return [name, compare(spec, code)];
      }),
    );
    await expect(`${JSON.stringify(all, null, 2)}\n`).toMatchFileSnapshot(
      "__golden__/mutations.findings.json",
    );
  });
});
