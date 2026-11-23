import type { Finding } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/index";

const FILE = "mini.behavior.yaml";

/** 14 lines; cases append to it or replace parts of it. */
const BASE = `behavior: Mini
entity:
  name: Order
  state: status
  states: [draft, paid, done]
  initial: draft
  terminal: [done]
actors:
  user: { trust: untrusted }
transitions:
  pay:
    from: draft
    to: paid
    by: user
`;

function only(text: string): Finding {
  const { findings } = parseSpec(text, FILE);
  expect(findings.map((f) => f.message)).toHaveLength(1);
  return findings[0] as Finding;
}

function expectFinding(text: string, message: string, line: number, column: number): Finding {
  const finding = only(text);
  expect(finding.message).toContain(message);
  expect([finding.specAt?.line, finding.specAt?.column]).toEqual([line, column]);
  return finding;
}

describe("schema errors", () => {
  it("a guard with several arguments cut in two by a flow mapping: says to quote it", () => {
    const text = BASE.replace(
      "{ trust: untrusted }",
      "{ trust: untrusted, requires: role(owner, admin) }",
    );
    const finding = expectFinding(text, 'actor "user": unknown key "admin)"', 9, 51);
    expect(finding.hint).toBe(
      'Inside `{ … }` a comma ends the value, so a guard with several arguments is cut in two: quote it, requires: "role(owner, admin)".',
    );
  });

  it.each([
    [
      "missing required key",
      BASE.replace("    to: paid\n", ""),
      'transition "pay": missing required key "to"',
      11,
      3,
    ],
    [
      "missing top-level key",
      BASE.replace(/entity:\n( {2}.*\n)+/, ""),
      'spec: missing required key "entity"',
      1,
      1,
    ],
    [
      "bad enum value",
      BASE.replace("untrusted", "untrustd"),
      'actor "user": "trust" must be one of untrusted, authenticated, signed-webhook, internal (got "untrustd")',
      9,
      18,
    ],
    [
      "wrong scalar type",
      `${BASE}    atomic: yes\n`,
      'transition "pay": "atomic" must be true or false (got "yes")',
      15,
      13,
    ],
    [
      "bad multiplicity",
      `${BASE}    effects:\n      - email.receipt: twice\n`,
      'transition "pay": "effects[0].email.receipt" must be one of exactly-once, at-least-once, idempotent (got "twice")',
      16,
      24,
    ],
    [
      "effect mapping with two keys",
      `${BASE}    effects:\n      - { a: idempotent, b: idempotent }\n`,
      'transition "pay": "effects[0]" must have exactly one key',
      16,
      9,
    ],
    [
      "effect of the wrong type",
      `${BASE}    effects: [5]\n`,
      'transition "pay": "effects[0]" must be a string or a mapping (got 5)',
      15,
      15,
    ],
    [
      "from of the wrong type",
      BASE.replace("from: draft", "from: 5"),
      'transition "pay": "from" must be a string or a list (got 5)',
      12,
      11,
    ],
    [
      "from list with a non-string item",
      BASE.replace("from: draft", "from: [draft, {}]"),
      'transition "pay": "from[1]" must be a string (got a mapping)',
      12,
      19,
    ],
    [
      "empty states",
      BASE.replace("[draft, paid, done]", "[]"),
      'entity: "states" must not be empty',
      5,
      11,
    ],
    [
      "kind other than entity",
      `${BASE}kind: process\n`,
      'spec: "kind" must be "entity" (got "process")',
      15,
      7,
    ],
    [
      "non-positive max_parallel",
      `${BASE}concurrency:\n  max_parallel: { pay: 0 }\n`,
      'concurrency: "max_parallel.pay" must be a positive integer (got 0)',
      16,
      24,
    ],
    [
      "non-integer default concurrency",
      `${BASE}concurrency:\n  default: 1.5\n`,
      'concurrency: "default" must be an integer (got 1.5)',
      16,
      12,
    ],
    [
      "bad duration",
      `${BASE}    after: 30 minutes\n`,
      'transition "pay": "after" must be a duration such as 30m, 2h or 7d (got "30 minutes")',
      15,
      12,
    ],
    [
      "unknown top-level key",
      `${BASE}sumary: typo\n`,
      'spec: unknown key "sumary" (did you mean "summary"?)',
      15,
      1,
    ],
    [
      "unknown key without a close match",
      `${BASE}    color: red\n`,
      'transition "pay": unknown key "color" (allowed: from, to, by, requires, effects, atomic, idempotent, after, impl)',
      15,
      5,
    ],
    [
      "unknown nested key",
      `${BASE}bindings:\n  clients:\n    db: { module: src/db.ts, exprt: db }\n`,
      'bindings: unknown key "exprt" in "clients.db" (did you mean "export"?)',
      17,
      30,
    ],
    [
      "rule with two kinds",
      `${BASE}rules:\n  - name: R\n    always: true\n    never: false\n`,
      'rule "R": "never" is not allowed together with "always"',
      18,
      12,
    ],
    [
      "rule without a kind",
      `${BASE}rules:\n  - name: R\n`,
      'rule "R": must have one of always, never, eventually',
      16,
      5,
    ],
    [
      "spec that is not a mapping",
      "- just\n- a list\n",
      "spec: must be a mapping (got a list)",
      1,
      1,
    ],
    ["empty file", "", "spec: must be a mapping (got an empty value)", 1, 1],
  ])("%s", (_name, text, message, line, column) => {
    const finding = expectFinding(text, message, line, column);
    expect(finding.severity).toBe("error");
  });

  it("reports a misspelt required key once, as unknown (not also as missing)", () => {
    expectFinding(
      BASE.replace("transitions:", "trasitions:"),
      'spec: unknown key "trasitions" (did you mean "transitions"?)',
      10,
      1,
    );
  });

  it("sets transition and behavior on transition findings", () => {
    const finding = only(`${BASE}    atomic: yes\n`);
    expect(finding).toMatchObject({ behavior: "Mini", transition: "pay" });
  });
});

describe("YAML errors", () => {
  it("reports syntax errors", () => {
    const { model, findings } = parseSpec("behavior: [oops\n", FILE);
    expect(model).toBeUndefined();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("YAML syntax error");
  });

  it("reports duplicate keys", () => {
    expectFinding(`${BASE}behavior: Again\n`, "YAML syntax error: Map keys must be unique", 15, 1);
  });
});

describe("semantic errors", () => {
  it.each([
    [
      "unknown state in from",
      BASE.replace("from: draft", "from: [draft, drift]"),
      'transition "pay": unknown state "drift" in "from" (declared: draft, paid, done)',
      12,
      19,
    ],
    [
      "unknown terminal state",
      BASE.replace("terminal: [done]", "terminal: [don]"),
      'entity: unknown state "don" in "terminal"',
      7,
      14,
    ],
    [
      "duplicate state",
      BASE.replace("[draft, paid, done]", "[draft, paid, done, paid]"),
      'entity: duplicate state "paid" in "states"',
      5,
      31,
    ],
    [
      '"*" inside a from list',
      BASE.replace("from: draft", 'from: [draft, "*"]'),
      'transition "pay": "*" must be used on its own',
      12,
      19,
    ],
    [
      "malformed guard in requires",
      `${BASE}    requires: ["role(admin"]\n`,
      'transition "pay": malformed guard "role(admin" in "requires"',
      15,
      16,
    ],
    [
      "malformed guard binding",
      `${BASE}bindings:\n  guards:\n    owner: requireOwner\n`,
      'bindings.guards "owner": malformed binding "requireOwner"',
      17,
      12,
    ],
    [
      "guard binding with an argument that can't be matched",
      `${BASE}bindings:\n  guards:\n    owner: 'a.ts#requireRole({ role: "admin" })'\n`,
      `bindings.guards "owner": malformed binding "a.ts#requireRole({ role: "admin" })"`,
      17,
      12,
    ],
    [
      "malformed guard binding key",
      `${BASE}bindings:\n  guards:\n    "role(": a.ts#f\n`,
      'bindings.guards: malformed guard "role("',
      17,
      5,
    ],
    [
      "guard bound twice after canonicalisation",
      `${BASE}    requires: role(admin)\nbindings:\n  guards:\n    role(admin): a.ts#f\n    role( admin ): a.ts#g\n`,
      'bindings.guards: guard "role(admin)" is bound twice (as "role(admin)" and "role( admin )")',
      19,
      5,
    ],
    [
      "unbound actor guard",
      `${BASE.replace("{ trust: untrusted }", "{ trust: untrusted, requires: [owner, verified] }")}bindings:\n  guards:\n    owner: a.ts#f\n`,
      'actor "user": guard "verified" has no binding in bindings.guards (bound: owner)',
      9,
      47,
    ],
    [
      "duplicate rule name",
      `${BASE}rules:\n  - { name: R, always: true }\n  - { name: R, never: false }\n`,
      'rule "R": duplicate rule name',
      17,
      13,
    ],
    [
      "rule without any declared effects",
      `${BASE}rules:\n  - { name: R, always: count(effect x) == 0 }\n`,
      'rule "R": unknown effect "x" (no transition declares any effects)',
      16,
      37,
    ],
  ])("%s", (_name, text, message, line, column) => {
    const finding = expectFinding(text, message, line, column);
    expect(finding.severity).toBe("error");
  });

  it('warns that from "*" leaves terminal states', () => {
    const text = BASE.replace("from: draft", 'from: "*"');
    const finding = expectFinding(text, 'from "*" includes the terminal states done', 12, 11);
    expect(finding.severity).toBe("warning");
    expect(parseSpec(text, FILE).model?.transitions[0]?.from).toBe("*");
  });

  it("falls back to the scalar start for multi-line rule expressions", () => {
    const text = `${BASE}rules:\n  - name: R\n    always: >-\n      status ==\n      nope\n`;
    expectFinding(text, 'rule "R": unknown state "nope"', 17, 13);
  });

  it("allows unbound guards when no guard is bound (design-only spec)", () => {
    const { model, findings } = parseSpec(`${BASE}    requires: [owner]\n`, FILE);
    expect(findings).toEqual([]);
    expect(model?.transitions[0]?.requires).toEqual([
      {
        name: "owner",
        args: [],
        raw: "owner",
        at: expect.objectContaining({ line: 15, column: 16 }),
      },
    ]);
  });

  describe("bindings", () => {
    const WITH_EFFECT = `${BASE}    effects: [stripe.refund]\n`;

    it("does not flag clients no effect or guard references", () => {
      const text = `${BASE}bindings:\n  clients:\n    db: { module: src/db.ts, export: db }\n`;
      expect(parseSpec(text, FILE).findings).toEqual([]);
    });

    it("skips the client check when no client is bound", () => {
      const text = `${WITH_EFFECT}bindings:\n  effects:\n    stripe.refund: stripe.refunds.create\n`;
      expect(parseSpec(text, FILE).findings).toEqual([]);
    });

    it("suggests adding a client that is not close to any bound one", () => {
      const text = `${WITH_EFFECT}bindings:\n  clients:\n    db: { module: src/db.ts, export: db }\n  effects:\n    stripe.refund: payments.refunds.create\n`;
      const finding = expectFinding(
        text,
        'bindings.effects "stripe.refund": unknown client "payments" in "payments.refunds.create" (bound clients: db)',
        20,
        20,
      );
      expect(finding.hint).toBe(
        "add `payments: { module: path/to/file.ts, export: payments }` under bindings.clients",
      );
    });

    it("reports an effect binding when no transition declares effects", () => {
      const text = `${BASE}bindings:\n  effects:\n    stripe.refund: stripe.refunds.create\n`;
      const finding = expectFinding(
        text,
        'bindings.effects: unknown effect "stripe.refund" (no transition declares any effects)',
        17,
        5,
      );
      expect(finding.severity).toBe("error");
    });

    it("counts actor requires as uses of a guard binding", () => {
      const text = `${BASE.replace("{ trust: untrusted }", "{ trust: untrusted, requires: role( admin ) }")}bindings:\n  guards:\n    role(admin): a.ts#f\n`;
      expect(parseSpec(text, FILE).findings).toEqual([]);
    });

    it("warns about an unused guard binding under its canonical name, at its key", () => {
      const text = `${BASE}bindings:\n  guards:\n    role( admin ): a.ts#f\n`;
      const finding = expectFinding(
        text,
        'bindings.guards: unused guard binding "role(admin)" (no transition or actor requires it)',
        17,
        5,
      );
      expect(finding.severity).toBe("warning");
      expect(parseSpec(text, FILE).model).toBeDefined();
    });
  });

  it("reports every problem, sorted by position, with unique ids", () => {
    const text = BASE.replace("to: paid", "to: payed").replace("by: user", "by: usr");
    const { findings } = parseSpec(text, FILE);
    expect(findings.map((f) => [f.specAt?.line, f.message.split(" (")[0]])).toEqual([
      [13, 'transition "pay": unknown state "payed" in "to"'],
      [14, 'transition "pay": unknown actor "usr" in "by"'],
    ]);
    expect(new Set(findings.map((f) => f.id)).size).toBe(2);
  });
});

describe("normalization", () => {
  it("applies defaults for every optional field", () => {
    const { model, findings } = parseSpec(BASE.replace("  terminal: [done]\n", ""), FILE);
    expect(findings).toEqual([]);
    expect(model).toMatchObject({
      kind: "entity",
      origin: "spec",
      file: FILE,
      entity: { terminal: [] },
      actors: { user: { name: "user", requires: [] } },
      rules: [],
      concurrency: { pay: 2 },
      bindings: { clients: {}, guards: {}, effects: {} },
    });
    expect(model?.summary).toBeUndefined();
    expect(model?.enforced).toBeUndefined();
    expect(model?.bindings.persistence).toBeUndefined();
    expect(model?.transitions[0]).toMatchObject({
      from: ["draft"],
      by: ["user"],
      requires: [],
      effects: [],
      atomic: false,
      idempotent: false,
    });
    expect(model?.transitions[0]?.impl).toBeUndefined();
    expect(model?.transitions[0]?.after).toBeUndefined();
  });

  it("keeps enforced only when it is true", () => {
    const enforced = (value: string) =>
      parseSpec(`enforced: ${value}\n${BASE}`, FILE).model?.enforced;
    expect(enforced("true")).toBe(true);
    expect(enforced("false")).toBeUndefined();
    const { findings } = parseSpec(`enforced: "yes"\n${BASE}`, FILE);
    expect(findings.map((f) => [f.specAt?.line, f.severity])).toEqual([[1, "error"]]);
  });

  it("resolves concurrency for every transition", () => {
    const text = `${BASE}  finish:\n    from: paid\n    to: done\n    by: user\nconcurrency:\n  default: 3\n  max_parallel: { finish: 1 }\n`;
    expect(parseSpec(text, FILE).model?.concurrency).toEqual({ finish: 1, pay: 3 });
  });

  it("accepts YAML booleans as the `true` / `false` rule expressions", () => {
    const text = `${BASE}rules:\n  - { name: T, always: true }\n  - { name: F, never: false }\n`;
    const { model, findings } = parseSpec(text, FILE);
    expect(findings).toEqual([]);
    expect(model?.rules.map((r) => [r.kind, r.source, r.expr])).toEqual([
      ["always", "true", { type: "bool", value: true }],
      ["never", "false", { type: "bool", value: false }],
    ]);
  });

  it("keys guard bindings by the canonical guard form", () => {
    const text = `${BASE}    requires: role( admin )\nbindings:\n  guards:\n    role( admin ): a.ts#requireRole("admin")\n`;
    const { model, findings } = parseSpec(text, FILE);
    expect(findings).toEqual([]);
    expect(model?.transitions[0]?.requires).toEqual([
      {
        name: "role",
        args: ["admin"],
        raw: "role(admin)",
        // The whole scalar, including the spaces the canonical form drops.
        at: { file: FILE, line: 15, column: 15, endLine: 15, endColumn: 28 },
      },
    ]);
    expect(Object.keys(model?.bindings.guards ?? {})).toEqual(["role(admin)"]);
  });
});

describe("fixtures", () => {
  it("normalizes fixtures with defaults", () => {
    const { model, findings } = parseSpec(
      `${BASE}fixtures:\n  entity: { id: o1 }\n  actors:\n    user: { id: u1 }\n`,
      FILE,
    );
    expect(findings).toEqual([]);
    expect(model?.fixtures).toMatchObject({
      entity: { id: "o1" },
      actors: { user: { id: "u1" } },
      args: {},
    });
  });

  it("rejects fixtures for an unknown actor", () => {
    expectFinding(
      `${BASE}fixtures:\n  actors:\n    usr: { id: u1 }\n`,
      'fixtures.actors: unknown actor "usr"',
      17,
      5,
    );
  });

  it("rejects args for an unknown transition", () => {
    expectFinding(
      `${BASE}fixtures:\n  args:\n    payy: [$id]\n`,
      'fixtures.args: unknown transition "payy"',
      17,
      5,
    );
  });

  it("omits fixtures when the section is absent", () => {
    expect(parseSpec(BASE, FILE).model?.fixtures).toBeUndefined();
  });
});
