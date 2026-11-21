// Expected from-sets for every fixture write site.

import type { FromSet } from "./narrowing.ts";

export const ALL: FromSet = [
  "cancelled",
  "draft",
  "paid",
  "pending_payment",
  "refunded",
  "shipped",
];

export interface Expectation {
  caseId: string;
  title: string;
  /** What the TypeScript checker answers at the write site (what we assert). */
  expected: FromSet;
  /** The semantically correct from-set, only when it differs from `expected` (a TS gap). */
  truth?: FromSet;
}

/**
 * The 11 required guard styles. 4 and 7 have a status-level and an object-level variant;
 * 8b shows the condition under which TS narrows through an aliased condition.
 */
export const REQUIRED: readonly Expectation[] = [
  { caseId: "case01_ifThrow", title: "1 if/throw", expected: ["paid"] },
  { caseId: "case02_switch", title: "2 switch", expected: ["paid"] },
  { caseId: "case03_earlyReturn", title: "3 early return", expected: ["paid", "shipped"] },
  { caseId: "case04a_assertStatus", title: "4a asserts status", expected: ["paid"] },
  { caseId: "case04b_assertOrder", title: "4b asserts order (spread)", expected: ["paid"] },
  { caseId: "case05_ternary", title: "5 ternary (spread)", expected: ["paid"] },
  { caseId: "case06_booleanHelper", title: "6 boolean helper (negative)", expected: ALL },
  {
    caseId: "case07a_predicateStatus",
    title: "7a predicate on status",
    expected: ["paid", "shipped"],
  },
  { caseId: "case07b_predicateOrder", title: "7b predicate on order (spread)", expected: ["paid"] },
  {
    caseId: "case08_aliasedCondition",
    title: "8 aliased condition, mutable field",
    expected: ALL,
    truth: ["paid"],
  },
  {
    caseId: "case08b_aliasedReadonly",
    title: "8b aliased condition, readonly",
    expected: ["paid"],
  },
  { caseId: "case09_multipleStates", title: "9 multiple states", expected: ["paid", "shipped"] },
  { caseId: "case10_callback", title: "10 tx callback", expected: ["paid"] },
  { caseId: "case11_spreadSave", title: "11 spread to save()", expected: ["paid"] },
];

/** Extra cases: they pin down what the checker answers, including known gaps. */
export const LIMITS: readonly Expectation[] = [
  { caseId: "limit01_stringGuarded", title: "L1 string field, guarded", expected: ["paid"] },
  { caseId: "limit02_stringUnguarded", title: "L2 string field, unguarded", expected: "*" },
  { caseId: "limit03_any", title: "L3 any entity", expected: "*", truth: ["paid"] },
  { caseId: "limit04_generic", title: "L4 generic T extends Order", expected: ["paid"] },
  { caseId: "limit05_tsEnum", title: "L5 TS enum", expected: ["paid"] },
  { caseId: "limit06_prismaEnum", title: "L6 Prisma-style const enum", expected: ["paid"] },
  {
    caseId: "limit07_localAlias",
    title: "L7 const s = order.status",
    expected: ALL,
    truth: ["paid"],
  },
  {
    caseId: "limit08_destructured",
    title: "L8 destructured status",
    expected: ALL,
    truth: ["paid"],
  },
  {
    caseId: "limit09_includes",
    title: "L9 array.includes guard",
    expected: ALL,
    truth: ["paid", "shipped"],
  },
  { caseId: "limit10_inferredPredicate", title: "L10 inferred predicate", expected: ["paid"] },
  { caseId: "limit11_closureAfterGuard", title: "L11 closure after guard", expected: ALL },
  { caseId: "limit12_acrossAwait", title: "L12 across await", expected: ["paid"] },
  { caseId: "limit13_reassigned", title: "L13 ref reassigned", expected: ALL },
  { caseId: "limit14_loopContinue", title: "L14 loop + continue", expected: ["paid"] },
  { caseId: "limit15_OrderEntity", title: "L15 this.status", expected: ["paid", "shipped"] },
  { caseId: "limit16_switchTrue", title: "L16 switch (true)", expected: ["paid"] },
];
