import type { Finding } from "@tsverify/ir";
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

const code = "/repo/src/orders/refund.ts";
const NON_ATOMIC = "non-atomic:Order lifecycle:refund";

/**
 * B3-shaped findings with `causedBy` links: a non-atomic refund explains two code-model property
 * violations, one of which explains a third finding in turn; another consequence names a cause
 * that is not in the list. Deliberately unsorted.
 */
export function causedFindings(): Finding[] {
  return [
    {
      id: "implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
      category: "implementation-property",
      severity: "error",
      message: "Exactly-once effect `stripe.refund` fires 2 times for one Order.",
      behavior: "Order lifecycle",
      transition: "refund",
      property: "effect-multiplicity",
      specAt: { file: spec, line: 52, column: 3 },
      codeAt: { file: code, line: 13, column: 24 },
      trace: b6DoubleRefundTrace(),
      hint: "make `refund`'s state check and write atomic in the code",
      causedBy: [NON_ATOMIC],
    },
    {
      id: "replay-confirmed:Order lifecycle:effect-multiplicity:stripe.refund:code-model",
      category: "replay-confirmed",
      severity: "error",
      message: "Replay confirmed in the real code: stripe.refund fires twice.",
      behavior: "Order lifecycle",
      transition: "refund",
      specAt: { file: spec, line: 52, column: 3 },
      causedBy: ["implementation-property:Order lifecycle:effect-multiplicity:stripe.refund"],
    },
    {
      id: NON_ATOMIC,
      category: "non-atomic",
      severity: "error",
      message: "refund: refundOrder reads the entity and writes refunded outside one atomic scope.",
      behavior: "Order lifecycle",
      transition: "refund",
      specAt: { file: spec, line: 52, column: 3 },
      codeAt: { file: code, line: 10, column: 23 },
      hint: "Wrap the read and write in one transaction or use a conditional update.",
    },
    {
      id: "implementation-property:Order lifecycle:rule:Refund issued at most once per order",
      category: "implementation-property",
      severity: "error",
      message: 'Rule "Refund issued at most once per order" is violated.',
      behavior: "Order lifecycle",
      property: "rule:Refund issued at most once per order",
      specAt: { file: spec, line: 62, column: 5 },
      trace: b6DoubleRefundTrace(),
      causedBy: [NON_ATOMIC],
    },
    {
      id: "implementation-property:Order lifecycle:effect-multiplicity:email.receipt",
      category: "implementation-property",
      severity: "warning",
      message: "Its cause is not in the list, so it renders as a top-level finding.",
      behavior: "Order lifecycle",
      specAt: { file: spec, line: 27, column: 3 },
      causedBy: ["from-state-unconstrained:Order lifecycle:payment_succeeded"],
    },
  ];
}
