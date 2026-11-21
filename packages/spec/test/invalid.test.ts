import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/index";

const DIR = fileURLToPath(new URL("fixtures/invalid/", import.meta.url));

interface Case {
  fixture: string;
  severity: "error" | "warning";
  message: string;
  line: number;
  column: number;
  hint?: string;
  transition?: string;
}

/** Each fixture has exactly one defect, so it must produce exactly one finding. */
const CASES: Case[] = [
  {
    fixture: "unknown-key",
    severity: "error",
    message: 'transition "pay": unknown key "idempotnet" (did you mean "idempotent"?)',
    line: 15,
    column: 5,
    transition: "pay",
  },
  {
    fixture: "unknown-state-to",
    severity: "error",
    message:
      'transition "refund": unknown state "refundd" in "to" (declared: draft, pending_payment, paid, refunded)',
    line: 13,
    column: 9,
    hint: 'did you mean "refunded"?',
    transition: "refund",
  },
  {
    fixture: "unknown-actor-by",
    severity: "error",
    message: 'transition "pay": unknown actor "admn" in "by" (declared: admin, system)',
    line: 15,
    column: 18,
    hint: 'did you mean "admin"?',
    transition: "pay",
  },
  {
    fixture: "bad-initial",
    severity: "error",
    message: 'entity: unknown state "drafts" in "initial" (declared: draft, paid)',
    line: 7,
    column: 12,
    hint: 'did you mean "draft"?',
  },
  {
    fixture: "duplicate-effect",
    severity: "error",
    message: 'transition "refund": duplicate effect "stripe.refund"',
    line: 18,
    column: 9,
    transition: "refund",
  },
  {
    fixture: "rule-syntax-error",
    severity: "error",
    message:
      'rule "Refund once": syntax error in "always" at character 29: unexpected character "=" (did you mean "<="?)',
    line: 18,
    column: 41,
  },
  {
    fixture: "rule-syntax-error-quoted",
    severity: "error",
    message: 'expected "]" to close the state list but found the end of the expression',
    line: 16,
    column: 56,
  },
  {
    fixture: "rule-unknown-state",
    severity: "error",
    message:
      'rule "Shipped orders are never refunded": unknown state "shiped" (declared: paid, shipped, refunded)',
    line: 22,
    column: 22,
    hint: 'did you mean "shipped"?',
  },
  {
    fixture: "rule-unknown-effect",
    severity: "error",
    message:
      'rule "Refund once": unknown effect "stripe.refnd" (declared on transitions: stripe.refund)',
    line: 18,
    column: 27,
    hint: 'did you mean "stripe.refund"?',
  },
  {
    fixture: "max-parallel-unknown",
    severity: "error",
    message: 'concurrency.max_parallel: unknown transition "refnd" (declared: refund)',
    line: 19,
    column: 5,
    hint: 'did you mean "refund"?',
  },
  {
    fixture: "malformed-impl",
    severity: "error",
    message:
      'transition "refund": malformed impl "src/orders/refund.ts" (expected "path/to/file.ts#symbol")',
    line: 15,
    column: 11,
    transition: "refund",
  },
  {
    fixture: "unbound-guard",
    severity: "error",
    message:
      'transition "pay": guard "owner" has no binding in bindings.guards (bound: role(admin))',
    line: 16,
    column: 16,
    hint: "add `owner: path/to/file.ts#symbol` under bindings.guards",
    transition: "pay",
  },
  {
    fixture: "terminal-outgoing",
    severity: "warning",
    message: 'transition "refund": terminal state "shipped" has an outgoing transition',
    line: 17,
    column: 18,
    hint: 'remove "shipped" from "from", or from entity.terminal',
    transition: "refund",
  },
];

describe("invalid fixtures", () => {
  it("every fixture file has a case", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".behavior.yaml"))
      .map((f) => f.replace(/\.behavior\.yaml$/, ""))
      .sort();
    expect(files).toEqual(CASES.map((c) => c.fixture).sort());
  });

  it.each(CASES)("$fixture", (c) => {
    const file = `test/fixtures/invalid/${c.fixture}.behavior.yaml`;
    const { model, findings } = parseSpec(
      readFileSync(`${DIR}${c.fixture}.behavior.yaml`, "utf8"),
      file,
    );
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.message).toContain(c.message);
    expect(finding).toMatchObject({
      id: `invalid-spec:${file}:${c.line}:${c.column}`,
      category: "invalid-spec",
      severity: c.severity,
      behavior: "Mini",
      specAt: { file, line: c.line, column: c.column },
    });
    expect(finding?.hint).toBe(c.hint);
    expect(finding?.transition).toBe(c.transition);
    if (c.severity === "warning") expect(model).toBeDefined();
    else expect(model).toBeUndefined();
  });
});
