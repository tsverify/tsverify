// Real inputs from the other packages' golden files: the checker's counterexample for the
// refund race and the extractor's code model of the demo app.
import { readFileSync } from "node:fs";
import type { BehaviorModel, Trace } from "@tsv/ir";

function golden<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

/** `packages/checker/test/__golden__/b6-refund-race.trace.json`. */
export const refundRaceTrace = golden<Trace>(
  "../../checker/test/__golden__/b6-refund-race.trace.json",
);

/** `packages/extractor/test/__golden__/orders-app.code.json` (the clean demo app). */
export const ordersAppCode = golden<BehaviorModel>(
  "../../extractor/test/__golden__/orders-app.code.json",
);

const testgenTraces = golden<Record<string, Trace>>("../../testgen/test/fixtures/traces.json");

/** B1 (`packages/testgen/test/fixtures/traces.json`): pay, an unlinked reopen, pay again. */
export const b1ReopenTrace = testgenTraces["b1-reopen"] as Trace;

/** B4 (`packages/testgen/test/fixtures/traces.json`): two atomic webhook deliveries. */
export const b4WebhookDupTrace = testgenTraces["b4-webhook-dup"] as Trace;
