/**
 * Acceptance: the extractor on testgen's named-storage fixture app
 * (`packages/testgen/test/fixtures/storage-app`) produces the code models that were written by
 * hand for it before the `functions` adapter existed (`order.code.json`, and the read + save
 * variant's).
 *
 * One location differs by design: the hand-written `declared` scope of `ship` spans the first
 * line of `withTransaction(async () => {` (6:9–6:38), while the extractor, like every other
 * adapter's scope (`db.transaction(…)`, `$transaction(…)`), records the whole call (6:9–13:5).
 * And the hand-written models copy the spec's `summary`, which no code model carries (the
 * extractor copies only what `ModelOrigin` lists: name, entity, actors, rules, bindings, file).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BehaviorModel } from "@tsverify/ir";
import { parseSpec } from "@tsverify/spec";
import { afterAll, describe, expect, it } from "vitest";
import { type ExtractResult, extractAll } from "../src/index";
import { installTypeScript } from "./typescript";

const APP = fileURLToPath(new URL("../../testgen/test/fixtures/storage-app/", import.meta.url));
const SPEC_FILE = "src/orders/order.behavior.yaml";
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2022",
    lib: ["es2022"],
    module: "esnext",
    moduleResolution: "bundler",
    types: [],
  },
  include: ["src"],
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A temp copy of the app (with `variant`'s files over it), extracted. */
function extract(variant?: string): ExtractResult {
  const root = mkdtempSync(join(tmpdir(), "tsverify-storage-app-"));
  roots.push(root);
  cpSync(join(APP, "src"), join(root, "src"), { recursive: true });
  if (variant) cpSync(join(APP, variant, "src"), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  const { model, findings } = parseSpec(readFileSync(join(root, SPEC_FILE), "utf8"), SPEC_FILE);
  if (!model) throw new Error(`invalid spec: ${JSON.stringify(findings)}`);
  const { results } = extractAll([model], { projectRoot: root, typescript: installTypeScript() });
  return results[0] as ExtractResult;
}

function handWritten(path: string): BehaviorModel {
  const model = JSON.parse(readFileSync(join(APP, path), "utf8")) as BehaviorModel;
  delete model.summary;
  return model;
}

/** Drops source locations of copied spec parts, which the hand-written models leave out. */
function withoutSpecAt(model: BehaviorModel): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "at" && k !== "effectsAt" && k !== "fromAt" && k !== "byAt")
        .map(([k, v]) => [k, strip(v)]),
    );
  };
  const copy = structuredClone(model);
  return {
    ...copy,
    entity: strip(copy.entity),
    actors: strip(copy.actors),
    rules: strip(copy.rules),
    bindings: strip(copy.bindings),
  };
}

describe("storage-app (clean): the extractor's model is the hand-written one", () => {
  const result = extract();

  it("reports no findings", () => {
    expect(result.findings).toEqual([]);
  });

  it("equals order.code.json, but for the declared scope's span", () => {
    const expected = handWritten("order.code.json");
    const ship = expected.transitions.find((t) => t.name === "ship");
    if (!ship?.sites?.atomic) throw new Error("fixture");
    // The whole `withTransaction(…)` call, as for every adapter's scope.
    ship.sites.atomic.at = { ...ship.sites.atomic.at, endLine: 13, endColumn: 5 };
    expect(withoutSpecAt(result.model as BehaviorModel)).toEqual(expected);
  });
});

describe("storage-app (read + save refund): the extractor's model is the hand-written one", () => {
  const result = extract("variants/read-save-refund");

  it("reports no findings", () => {
    expect(result.findings).toEqual([]);
  });

  it("equals the variant's order.code.json, but for the declared scope's span", () => {
    const expected = handWritten("variants/read-save-refund/order.code.json");
    const ship = expected.transitions.find((t) => t.name === "ship");
    if (!ship?.sites?.atomic) throw new Error("fixture");
    ship.sites.atomic.at = { ...ship.sites.atomic.at, endLine: 13, endColumn: 5 };
    expect(withoutSpecAt(result.model as BehaviorModel)).toEqual(expected);
  });
});
