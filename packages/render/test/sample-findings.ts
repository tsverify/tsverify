import type { Finding } from "@tsv/ir";
import { b6DoubleRefundTrace } from "./b6-trace";

export const SAMPLE_CWD = "/repo";

const spec = "/repo/src/orders/order.behavior.yaml";

/** A mixed, deliberately unsorted list: every severity, two behaviors, one finding without one. */
export function sampleFindings(): Finding[] {
  return [
    {
      id: "unanalyzable:Order lifecycle:legacy",
      category: "unanalyzable",
      severity: "info",
      message: "Could not follow a dynamic call; effects of refundLegacy were not analyzed.",
      behavior: "Order lifecycle",
      codeAt: { file: "src/orders/legacy.ts", line: 3, column: 1 },
    },
    {
      id: "non-atomic:Order lifecycle:refund",
      category: "non-atomic",
      severity: "warning",
      message: "refund: the status read and the write are separate awaits; the spec says atomic.",
      behavior: "Order lifecycle",
      transition: "refund",
      specAt: { file: spec, line: 50, column: 5 },
      codeAt: { file: "/repo/src/orders/refund.ts", line: 12, column: 3 },
    },
    {
      id: "spec-property:Order lifecycle:effect-multiplicity",
      category: "spec-property",
      severity: "error",
      message: "Two parallel refunds both pass the paid check, so stripe.refund fires twice.",
      behavior: "Order lifecycle",
      transition: "refund",
      property: "effect-multiplicity",
      specAt: { file: spec, line: 52, column: 5 },
      trace: b6DoubleRefundTrace(),
      hint: "Mark refund atomic: true, or make the\nstripe.refund call idempotent.",
    },
    {
      id: "invalid-spec:bad.behavior.yaml:states",
      category: "invalid-spec",
      severity: "error",
      message: "Unknown state 'shiped' in transition ship.\nDid you mean 'shipped'?",
      specAt: { file: "/repo/src/bad.behavior.yaml", line: 3, column: 9 },
    },
    {
      id: "reachable:Inventory",
      category: "spec-property",
      severity: "warning",
      message: "State 'archived' is not reachable from 'active'.",
      behavior: "Inventory",
      property: "reachable",
      specAt: { file: "/elsewhere/inventory.behavior.yaml", line: 8, column: 3 },
    },
    {
      id: "guard-not-dominating:Order lifecycle:refund",
      category: "guard-not-dominating",
      severity: "error",
      message: "refund: requireRole('admin') does not dominate the write (early-return branch).",
      behavior: "Order lifecycle",
      transition: "refund",
      specAt: { file: spec, line: 45, column: 5 },
      codeAt: { file: "/repo/src/orders/refund.ts", line: 19, column: 3 },
    },
    {
      id: "reachable:Order lifecycle:nowhere",
      category: "spec-property",
      severity: "warning",
      message: "A warning without any location sorts after located warnings.",
      behavior: "Order lifecycle",
    },
  ];
}
