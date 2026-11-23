/**
 * `bindings.storage`: the preset form (an alias of `persistence`), the named-function form, and
 * every validation rule of the storage block, with its message and location.
 */
import type { Finding } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/index";

const FILE = "mini.behavior.yaml";

/** 15 lines; cases append a `bindings` body from line 16 on. */
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
bindings:
`;

function only(body: string): Finding {
  const { findings } = parseSpec(BASE + body, FILE);
  expect(findings.map((f) => f.message)).toHaveLength(1);
  return findings[0] as Finding;
}

const at = (line: number, column: number) => expect.objectContaining({ file: FILE, line, column });

describe("bindings.storage: normalization", () => {
  it("normalizes the preset form into persistence, like the persistence alias", () => {
    for (const body of ["  storage: prisma\n", "  persistence: prisma\n"]) {
      const { model, findings } = parseSpec(BASE + body, FILE);
      expect(findings).toEqual([]);
      expect(model?.bindings.persistence).toBe("prisma");
      expect(model?.bindings.storage).toBeUndefined();
    }
  });

  it("applies the default key and roles to path#symbol items", () => {
    const { model, findings } = parseSpec(
      `${BASE}  storage:
    read: src/orders/repo.ts#getOrder
    save: src/orders/repo.ts#saveOrder
    update: src/orders/repo.ts#setStatusIf
    atomic: src/db.ts#withTransaction
`,
      FILE,
    );
    expect(findings).toEqual([]);
    expect(model?.bindings.persistence).toBeUndefined();
    expect(model?.bindings.storage).toEqual({
      key: "id",
      read: [
        {
          ref: { file: "src/orders/repo.ts", symbol: "getOrder" },
          args: ["key"],
          at: at(17, 11),
        },
      ],
      save: [
        {
          ref: { file: "src/orders/repo.ts", symbol: "saveOrder" },
          args: ["entity"],
          at: at(18, 11),
        },
      ],
      update: [
        {
          ref: { file: "src/orders/repo.ts", symbol: "setStatusIf" },
          args: ["key", "from", "to"],
          at: at(19, 13),
        },
      ],
      atomic: [
        {
          ref: { file: "src/db.ts", symbol: "withTransaction" },
          args: ["callback"],
          at: at(20, 13),
        },
      ],
      at: at(16, 3),
    });
  });

  it("reads the long form and lists, keeping YAML order", () => {
    const { model, findings } = parseSpec(
      `${BASE}  storage:
    key: orderId
    read:
      - src/repo.ts#getOrder
      - { fn: src/repo.ts#findOrder, args: [_, key] }
    save: { fn: src/repo.ts#patchOrder, args: [key, patch] }
    update:
      - { fn: src/repo.ts#markPaid, from: draft, to: paid, returns: count }
      - { fn: src/repo.ts#setStatusIf, args: [key, to], from: [draft, paid], returns: throws }
`,
      FILE,
    );
    expect(findings).toEqual([]);
    const storage = model?.bindings.storage;
    expect(storage?.key).toBe("orderId");
    expect(storage?.read.map((f) => [f.ref.symbol, f.args])).toEqual([
      ["getOrder", ["key"]],
      ["findOrder", ["_", "key"]],
    ]);
    expect(storage?.save[0]?.args).toEqual(["key", "patch"]);
    expect(storage?.update).toEqual([
      {
        ref: { file: "src/repo.ts", symbol: "markPaid" },
        args: ["key"],
        returns: "count",
        from: ["draft"],
        to: "paid",
        at: at(23, 9),
      },
      {
        ref: { file: "src/repo.ts", symbol: "setStatusIf" },
        args: ["key", "to"],
        returns: "throws",
        from: ["draft", "paid"],
        at: at(24, 9),
      },
    ]);
    expect(storage?.atomic).toEqual([]);
  });
});

describe("bindings.storage: validation", () => {
  it.each([
    [
      "persistence and storage together",
      "  persistence: assign\n  storage: prisma\n",
      'bindings: "persistence" and "storage" are mutually exclusive (storage replaces persistence)',
      [16, 3],
      'remove "persistence: assign" and keep storage: prisma',
    ],
    [
      "persistence with the named-function form",
      "  persistence: assign\n  storage:\n    read: src/a.ts#get\n",
      'bindings: "persistence" and "storage" are mutually exclusive (storage replaces persistence)',
      [16, 3],
      'remove "persistence: assign" and keep the storage functions',
    ],
    [
      "a client named storage with the named-function form",
      "  storage:\n    read: src/a.ts#get\n  clients:\n    storage: { module: src/s.ts, export: storage }\n",
      'bindings.clients: "storage" is reserved when bindings.storage names the app\'s functions (a call to one is the gate storage.<symbol>, which a client of that name would share)',
      [19, 5],
      "rename the client (e.g. `blob`), and the paths in bindings.effects that start with `storage.`",
    ],
    [
      "no read, save or update",
      "  storage:\n    key: id\n    atomic: src/db.ts#tx\n",
      "bindings.storage: names no read, save or update function (at least one is required)",
      [16, 3],
      "add `read: path/to/file.ts#symbol` (the function that loads one Order by key) and `save:` (the one that persists it)",
    ],
    [
      "only empty lists",
      "  storage:\n    read: []\n    save: []\n",
      "bindings.storage: names no read, save or update function (at least one is required)",
      [16, 3],
      expect.any(String),
    ],
    [
      "read without key",
      "  storage:\n    read: { fn: src/repo.ts#get, args: [_] }\n",
      'bindings.storage.read "src/repo.ts#get": a read function needs a "key" argument (args: [_])',
      [17, 40],
      "e.g. args: [key]",
    ],
    [
      "save without entity or key + patch",
      "  storage:\n    save: { fn: src/repo.ts#save, args: [key] }\n",
      'bindings.storage.save "src/repo.ts#save": a save function needs an "entity" argument, or "key" and "patch" (args: [key])',
      [17, 41],
      "e.g. args: [entity] or args: [key, patch]",
    ],
    [
      "save with entity and patch",
      "  storage:\n    save: { fn: src/repo.ts#save, args: [entity, patch] }\n",
      'bindings.storage.save "src/repo.ts#save": a save function takes an "entity" or a "patch", not both (args: [entity, patch])',
      [17, 41],
      "e.g. args: [entity] or args: [key, patch]",
    ],
    [
      "update without key",
      "  storage:\n    update: { fn: src/repo.ts#u, args: [from, to] }\n",
      'bindings.storage.update "src/repo.ts#u": a conditional save (update) needs a "key" argument (args: [from, to])',
      [17, 40],
      "e.g. args: [key, from, to]",
    ],
    [
      "update without from-states",
      "  storage:\n    update: { fn: src/repo.ts#u, args: [key, to] }\n",
      'bindings.storage.update "src/repo.ts#u": a conditional save needs its from-states: a "from" argument, or a fixed "from:" (args: [key, to])',
      [17, 40],
      'add "from" to args, or write from: [paid]',
    ],
    [
      "update without target state",
      "  storage:\n    update: { fn: src/repo.ts#u, args: [key, from] }\n",
      'bindings.storage.update "src/repo.ts#u": a conditional save needs its target state: a "to" argument, or a fixed "to:" (args: [key, from])',
      [17, 40],
      'add "to" to args, or write to: refunded',
    ],
    [
      "update with from-states given twice",
      "  storage:\n    update: { fn: src/repo.ts#u, args: [key, from, to], from: [draft] }\n",
      'bindings.storage.update "src/repo.ts#u": the from-states are given twice, by a "from" argument and by the fixed "from:" (keep one)',
      [17, 57],
      undefined,
    ],
    [
      "update with the target state given twice",
      "  storage:\n    update: { fn: src/repo.ts#u, args: [key, from, to], to: paid }\n",
      'bindings.storage.update "src/repo.ts#u": the target state is given twice, by a "to" argument and by the fixed "to:" (keep one)',
      [17, 57],
      undefined,
    ],
    [
      "update with an undeclared fixed from-state",
      "  storage:\n    update: { fn: src/repo.ts#u, from: [draft, pai], to: done }\n",
      'bindings.storage.update "src/repo.ts#u": unknown state "pai" in "from" (declared: draft, paid, done)',
      [17, 48],
      'did you mean "paid"?',
    ],
    [
      "update with an undeclared fixed from-state, written as a string",
      "  storage:\n    update: { fn: src/repo.ts#u, from: drafft, to: done }\n",
      'bindings.storage.update "src/repo.ts#u": unknown state "drafft" in "from" (declared: draft, paid, done)',
      [17, 40],
      'did you mean "draft"?',
    ],
    [
      "update with an undeclared fixed target state",
      "  storage:\n    update: { fn: src/repo.ts#u, from: [draft], to: dne }\n",
      'bindings.storage.update "src/repo.ts#u": unknown state "dne" in "to" (declared: draft, paid, done)',
      [17, 53],
      'did you mean "done"?',
    ],
    [
      "atomic without callback",
      "  storage:\n    read: src/a.ts#r\n    atomic: { fn: src/db.ts#tx, args: [_] }\n",
      'bindings.storage.atomic "src/db.ts#tx": an atomic function needs a "callback" argument (args: [_])',
      [18, 39],
      "e.g. args: [callback]",
    ],
    [
      "a role twice",
      "  storage:\n    read: { fn: src/repo.ts#get, args: [key, key] }\n",
      'bindings.storage.read "src/repo.ts#get": role "key" appears twice in "args" (each role names one argument; "_" ignores one)',
      [17, 46],
      undefined,
    ],
    [
      "a role the kind does not take",
      "  storage:\n    read: { fn: src/repo.ts#get, args: [key, patch] }\n",
      'bindings.storage.read "src/repo.ts#get": a read function takes no "patch" argument (its roles: key, _)',
      [17, 46],
      'use "_" for an argument tsverify should ignore',
    ],
    [
      "a symbol bound twice",
      "  storage:\n    read: src/a.ts#get\n    save: [src/a.ts#save, src/b.ts#get]\n",
      'bindings.storage.save "src/b.ts#get": function name "get" is already bound (as read "src/a.ts#get"); storage function names must be unique, because a call is identified by its name',
      [18, 27],
      "bind each storage function once, under the kind it performs",
    ],
    [
      "a symbol bound twice in the long form",
      "  storage:\n    read: src/a.ts#get\n    update: { fn: src/b.ts#get }\n",
      'bindings.storage.update "src/b.ts#get": function name "get" is already bound',
      [18, 19],
      expect.any(String),
    ],
    [
      "a malformed ref",
      "  storage:\n    read: getOrder\n",
      'bindings.storage.read: malformed function "getOrder" (expected "path/to/file.ts#symbol")',
      [17, 11],
      undefined,
    ],
    [
      "a malformed ref in the long form",
      "  storage:\n    save: { fn: src/a.ts, args: [entity] }\n",
      'bindings.storage.save: malformed function "src/a.ts" (expected "path/to/file.ts#symbol")',
      [17, 17],
      undefined,
    ],
    [
      "a misspelt preset",
      "  storage: prsma\n",
      'bindings: "storage" must be one of assign, prisma, memory (got "prsma")',
      [16, 12],
      'did you mean "prisma"?',
    ],
    [
      "a misspelt role",
      "  storage:\n    save: { fn: src/repo.ts#save, args: [entty] }\n",
      'bindings: "storage.save.args[0]" must be one of key, entity, patch, from, to, callback, _ (got "entty")',
      [17, 42],
      'did you mean "entity"?',
    ],
    [
      "a misspelt returns",
      "  storage:\n    update: { fn: src/a.ts#u, returns: chaged }\n",
      'bindings: "storage.update.returns" must be one of changed, count, entity, throws (got "chaged")',
      [17, 40],
      'did you mean "changed"?',
    ],
    [
      "a misspelt kind",
      "  storage:\n    reed: src/a.ts#get\n",
      'bindings: unknown key "reed" in "storage" (did you mean "read"?)',
      [17, 5],
      undefined,
    ],
    [
      "a misspelt long-form key",
      "  storage:\n    read: { fn: src/a.ts#get, arg: [key] }\n",
      'bindings: unknown key "arg" in "storage.read" (did you mean "args"?)',
      [17, 31],
      undefined,
    ],
    [
      "returns on a read",
      "  storage:\n    read: { fn: src/a.ts#get, returns: count }\n",
      'bindings: unknown key "returns" in "storage.read" (allowed: fn, args)',
      [17, 31],
      undefined,
    ],
  ])("%s", (_name, body, message, [line, column], hint) => {
    const finding = only(body);
    expect(finding.message).toContain(message);
    expect(finding.severity).toBe("error");
    expect([finding.specAt?.line, finding.specAt?.column]).toEqual([line, column]);
    expect(finding.hint).toEqual(hint);
  });

  it('allows "_" more than once and the default roles everywhere', () => {
    const { findings } = parseSpec(
      `${BASE}  storage:
    read: { fn: src/a.ts#get, args: [_, key, _] }
    save: src/a.ts#save
    update: src/a.ts#setStatusIf
    atomic: src/a.ts#tx
`,
      FILE,
    );
    expect(findings).toEqual([]);
  });

  it("allows a client named storage with a preset (no storage.<symbol> gates then)", () => {
    const { findings } = parseSpec(
      `${BASE}  storage: assign
  clients:
    storage: { module: src/s.ts, export: storage }
`,
      FILE,
    );
    expect(findings).toEqual([]);
  });

  it("reports every problem of one function", () => {
    const { findings } = parseSpec(
      `${BASE}  storage:\n    update: { fn: src/a.ts#u, args: [to, to, callback] }\n`,
      FILE,
    );
    expect(findings.map((f) => f.message.split(": ").slice(1).join(": "))).toEqual([
      'a conditional save (update) needs a "key" argument (args: [to, to, callback])',
      'a conditional save needs its from-states: a "from" argument, or a fixed "from:" (args: [to, to, callback])',
      'role "to" appears twice in "args" (each role names one argument; "_" ignores one)',
      'a conditional save (update) takes no "callback" argument (its roles: key, from, to, patch, _)',
    ]);
  });
});
