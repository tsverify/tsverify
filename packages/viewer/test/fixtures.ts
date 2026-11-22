import { readFileSync } from "node:fs";
import type { Finding, Trace } from "@tsverify/ir";
import type { SpecInput } from "../src/view-data";

/**
 * Real pipeline output (`tsverify check` steps, run on the materialized orders-app variant with the
 * app as the cwd), one spec each:
 * - `b3-refund-race`: the code model's double refund, caused by the `non-atomic` refund
 * - `b6-spec-race`: the spec's own double refund (`refund` is `atomic: false`)
 *
 * Regenerate after a pipeline change by running the CLI's `runCheck` on a materialized copy
 * and keeping `file`, `behavior`, `project`, `spec`, `code` and `findings` of the one spec.
 */
export type Variant = "b3-refund-race" | "b6-spec-race";

export function variantInput(variant: Variant): SpecInput {
  const url = new URL(`./fixtures/${variant}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as SpecInput;
}

/** The variant's finding about `property` that carries a trace. */
export function tracedFinding(input: SpecInput, property: string): Finding & { trace: Trace } {
  const finding = input.findings.find((f) => f.property === property && f.trace !== undefined);
  if (!finding?.trace) throw new Error(`no traced ${property} finding`);
  return finding as Finding & { trace: Trace };
}
