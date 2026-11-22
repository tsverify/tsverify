import { describe, expect, it } from "vitest";
import { extractAll } from "../src/index";
import {
  extractFixture,
  fixtureRoot,
  guardKeys,
  libBindings,
  orderSpec,
  transitionOf,
} from "./helpers";

describe("transaction-atomic", () => {
  const result = extractFixture(
    "transaction-atomic",
    orderSpec([
      { name: "ship", impl: "src/ship.ts#shipOrder", to: "shipped" },
      { name: "ship_root", impl: "src/ship.ts#shipBypassingTx", to: "shipped" },
    ]),
  );

  it("reads, writes and saves through tx inside db.transaction: atomic", () => {
    const t = transitionOf(result, "ship");
    expect(t.atomic).toBe(true);
    expect(t.from).toEqual(["paid"]);
    expect(t.sites?.fromState).toEqual({ values: ["paid"], unconstrained: false });
    expect(t.sites?.atomic).toMatchObject({ kind: "transaction", gate: "db.transaction" });
    expect(t.sites?.atomic?.at).toMatchObject({ file: "src/ship.ts", line: 6 });
    expect(t.sites?.read).toMatchObject({
      client: "db",
      path: "orders.get",
      gate: "db.orders.get",
      occurrence: 0,
      at: { file: "src/ship.ts", line: 7 },
    });
    expect(t.sites?.commit).toMatchObject({ gate: "db.orders.save", at: { line: 10 } });
    expect(t.sites?.storage).toEqual({ client: "db", collection: "orders", key: "id" });
    expect(t.sites?.write).toMatchObject({ file: "src/ship.ts", line: 9, column: 5 });
    expect(t.at).toEqual(t.sites?.write);
    expect(t.sites?.invocation).toEqual({
      impl: { file: "src/ship.ts", symbol: "shipOrder" },
      entityId: { param: 1, path: [] },
    });
    expect(t.sites?.effects).toEqual([]);
  });

  it("reads through the root client inside the callback: not atomic", () => {
    const t = transitionOf(result, "ship_root");
    expect(t.atomic).toBe(false);
    expect(t.sites?.atomic).toBeUndefined();
    expect(t.sites?.read?.gate).toBe("db.orders.get");
    expect(t.sites?.commit?.gate).toBe("db.orders.save");
  });

  it("reports no findings and keeps the spec's non-transition parts", () => {
    expect(result.findings).toEqual([]);
    const spec = orderSpec([]);
    expect(result.model).toMatchObject({
      kind: "entity",
      origin: "code",
      name: spec.name,
      entity: spec.entity,
      actors: spec.actors,
      bindings: spec.bindings,
      concurrency: { ship: 2, ship_root: 2 },
    });
  });

  it("records where each resolved impl is declared", () => {
    expect(result.model?.implAt).toEqual({
      ship: { file: "src/ship.ts", line: 5, column: 23, endLine: 5, endColumn: 32 },
      ship_root: { file: "src/ship.ts", line: 16, column: 23, endLine: 16, endColumn: 38 },
    });
  });
});

describe("non-atomic get/save", () => {
  const result = extractFixture(
    "non-atomic",
    orderSpec([{ name: "refund", impl: "src/refund.ts#refundOrder", to: "refunded" }]),
  );

  it("has read and commit outside any scope", () => {
    const t = transitionOf(result, "refund");
    expect(t.atomic).toBe(false);
    expect(t.sites?.atomic).toBeUndefined();
    expect(t.sites?.read).toMatchObject({ gate: "db.orders.get", at: { line: 6 } });
    expect(t.sites?.commit).toMatchObject({ gate: "db.orders.save", at: { line: 10 } });
    expect(t.from).toEqual(["paid"]);
    expect(t.effects).toEqual([{ name: "stripe.refund", multiplicity: "at-least-once" }]);
  });
});

describe("read hidden in a helper", () => {
  const names = [
    "shipDirect",
    "shipAwaited",
    "shipViaConst",
    "shipNested",
    "shipRepo",
    "shipWithRoot",
    "shipOutside",
  ];
  const result = extractFixture(
    "hidden-read",
    orderSpec(names.map((n) => ({ name: n, impl: `src/ship.ts#${n}`, to: "shipped" }))),
  );

  it.each([
    ["shipDirect", 5],
    ["shipAwaited", 9],
    ["shipViaConst", 14],
    ["shipNested", 5],
    ["shipRepo", 23],
  ])("%s: the helper's return is the read, in the transaction: atomic", (name, line) => {
    const t = transitionOf(result, name);
    expect(t.atomic).toBe(true);
    expect(t.sites?.atomic).toMatchObject({ kind: "transaction", gate: "db.transaction" });
    expect(t.sites?.read).toMatchObject({
      client: "db",
      path: "orders.get",
      gate: "db.orders.get",
      occurrence: 0,
      at: { file: "src/ship.ts", line },
    });
    expect(t.sites?.storage).toEqual({ client: "db", collection: "orders", key: "id" });
    expect(t.sites?.invocation?.entityId).toEqual({ param: 0, path: [] });
  });

  it("a helper called with the root client reads outside the scope: not atomic", () => {
    const t = transitionOf(result, "shipWithRoot");
    expect(t.atomic).toBe(false);
    expect(t.sites?.read).toMatchObject({ gate: "db.orders.get", at: { line: 5 } });
  });

  it("without a scope the read is still found: not atomic, no warning", () => {
    const t = transitionOf(result, "shipOutside");
    expect(t.atomic).toBe(false);
    expect(t.sites?.read?.gate).toBe("db.orders.get");
    expect(t.sites?.commit?.gate).toBe("db.orders.save");
    expect(result.findings).toEqual([]);
  });
});

describe("helper write (interprocedural)", () => {
  const result = extractFixture(
    "helper-write",
    orderSpec([
      {
        name: "cancel",
        impl: "src/cancel.ts#onCancelRequested",
        from: ["pending_payment"],
        to: "cancelled",
        by: ["system"],
      },
    ]),
  );

  it("attributes the helper's write and the other helper's effect to the impl", () => {
    const t = transitionOf(result, "cancel");
    expect(t.sites?.specTransition).toBe("cancel");
    expect(t.sites?.function).toMatchObject({ file: "src/cancel.ts", name: "markCancelled" });
    expect(t.from).toEqual(["pending_payment"]);
    expect(t.atomic).toBe(true);
    expect(t.by).toEqual(["system"]);
    expect(t.sites?.effects.map((e) => [e.gate, e.effect])).toEqual([
      ["email.send", "email.receipt"],
    ]);
  });

  it("traces the entity id through the helper's parameter back to the impl", () => {
    const t = transitionOf(result, "cancel");
    expect(t.sites?.invocation).toEqual({
      impl: { file: "src/cancel.ts", symbol: "onCancelRequested" },
      entityId: { param: 0, path: ["orderId"] },
    });
  });
});

describe("guard dominance", () => {
  const names = [
    "guardBefore",
    "guardInsideAfterRead",
    "guardOnBothBranches",
    "guardViaWrapper",
    "guardBeforeHelper",
    "guardOnOneBranch",
    "guardSwallowed",
    "guardAfterWrite",
    "guardBypassedByEarlyReturn",
  ];
  const result = extractFixture(
    "guard-dominance",
    orderSpec(names.map((n) => ({ name: n, impl: `src/cases.ts#${n}`, to: "shipped" }))),
  );
  const facts = (name: string) => {
    const t = transitionOf(result, name);
    return {
      requires: guardKeys(t),
      guards: t.sites?.guards.map((g) => `${g.guard}:${g.dominates}`),
    };
  };

  it.each([
    ["guardBefore", ["role(admin)"], ["role(admin):true"]],
    ["guardInsideAfterRead", ["owner"], ["owner:true"]],
    ["guardOnBothBranches", ["role(admin)"], ["role(admin):true", "role(admin):true"]],
    ["guardViaWrapper", ["role(admin)"], ["role(admin):true"]],
    ["guardBeforeHelper", ["role(admin)"], ["role(admin):true"]],
  ])("%s: dominates", (name, requires, guards) => {
    expect(facts(name)).toEqual({ requires, guards });
  });

  it.each([
    ["guardOnOneBranch", ["role(admin):false"]],
    ["guardSwallowed", ["role(admin):false"]],
    ["guardAfterWrite", []],
    ["guardBypassedByEarlyReturn", ["role(admin):false"]],
  ])("%s: does not dominate", (name, guards) => {
    expect(facts(name)).toEqual({ requires: [], guards });
  });

  it("points a wrapper's guard entry at the wrapper call in the impl", () => {
    const g = transitionOf(result, "guardViaWrapper").sites?.guards[0];
    expect(g?.at).toMatchObject({ file: "src/cases.ts", line: 57 });
  });

  it("reads the actor from the guard call", () => {
    const t = transitionOf(result, "guardInsideAfterRead");
    expect(t.sites?.invocation?.actor).toEqual({ param: 0, path: ["actor"] });
  });

  it("names a helper write after the helper but links it to the impl", () => {
    const t = transitionOf(result, "guardBypassedByEarlyReturn");
    expect(t.sites?.function.name).toBe("ship");
    expect(t.sites?.specTransition).toBe("guardBypassedByEarlyReturn");
    expect(t.sites?.invocation?.entityId).toEqual({ param: 1, path: [] });
  });
});

describe("guard argument mismatch", () => {
  const result = extractFixture(
    "guard-arg-mismatch",
    orderSpec([
      { name: "support", impl: "src/ship.ts#shipAsSupport", to: "shipped" },
      { name: "admin_const", impl: "src/ship.ts#shipAsAdminConst", to: "shipped" },
    ]),
  );

  it('requireRole(…, "support") is not role(admin)', () => {
    const t = transitionOf(result, "support");
    expect(guardKeys(t)).toEqual([]);
    expect(t.sites?.guards).toEqual([]);
  });

  it("a constant with a literal type matches", () => {
    expect(guardKeys(transitionOf(result, "admin_const"))).toEqual(["role(admin)"]);
  });
});

describe("effect mapping", () => {
  const result = extractFixture(
    "effect-mapping",
    orderSpec([
      {
        name: "refund",
        impl: "src/refund.ts#refundOrder",
        to: "refunded",
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      },
      {
        name: "ship",
        impl: "src/refund.ts#shipOrder",
        to: "shipped",
        effects: [{ name: "email.receipt", multiplicity: "idempotent" }],
      },
    ]),
  );

  it("maps gates to spec effect names, keeps unmapped gates, takes multiplicity from the spec", () => {
    const t = transitionOf(result, "refund");
    expect(t.effects).toEqual([
      { name: "audit.log", multiplicity: "at-least-once" },
      { name: "email.receipt", multiplicity: "idempotent" },
      { name: "stripe.refund", multiplicity: "exactly-once" },
    ]);
    expect(t.sites?.effects.map((e) => [e.effect, e.client, e.path, e.occurrence])).toEqual([
      ["stripe.refund", "stripe", "refunds.create", 0],
      ["audit.log", "audit", "log", 0],
      ["email.receipt", "email", "send", 0],
      ["email.receipt", "email", "send", 1],
    ]);
  });

  it("neither counts persistence calls nor descends into a client's implementation", () => {
    const gates = transitionOf(result, "refund").sites?.effects.map((e) => e.gate);
    expect(gates).not.toContain("ledger.record");
    expect(gates?.some((g) => g.startsWith("db."))).toBe(false);
  });

  it("counts occurrences per path: exclusive branches are both the first", () => {
    const effects = transitionOf(result, "ship").sites?.effects;
    expect(effects?.map((e) => [e.gate, e.occurrence])).toEqual([
      ["email.send", 0],
      ["email.send", 0],
    ]);
  });
});

describe("effects on the write's path", () => {
  const result = extractFixture(
    "effect-path",
    orderSpec([
      { name: "ship", impl: "src/orders.ts#shipOrder", to: "shipped" },
      { name: "refund", impl: "src/orders.ts#refundOrder", to: "refunded" },
      {
        name: "pay",
        impl: "src/orders.ts#payOrder",
        from: ["pending_payment"],
        to: "paid",
        by: ["system"],
      },
      {
        name: "cancel",
        impl: "src/orders.ts#cancelOrder",
        from: ["pending_payment"],
        to: "cancelled",
        by: ["system"],
      },
    ]),
  );
  const effects = (name: string) =>
    transitionOf(result, name).sites?.effects.map((e) => [e.gate, e.at.line]);

  it("a catch around the transaction is not on the path; the call after it is", () => {
    expect(effects("ship")).toEqual([["email.send", 17]]);
  });

  it("a rejection branch and a catch around the commit are not; the call before the write is", () => {
    expect(effects("refund")).toEqual([["stripe.refunds.create", 30]]);
    expect(transitionOf(result, "refund").effects.map((e) => e.name)).toEqual(["stripe.refund"]);
  });

  it("a flag returned from the transaction: the helper called after the commit is attributed", () => {
    expect(effects("pay")).toEqual([["email.send", 60]]);
  });

  it("the write in a helper: the catch around the helper call is not attributed", () => {
    expect(effects("cancel")).toEqual([["email.send", 71]]);
  });
});

describe("unlinked write", () => {
  const result = extractFixture(
    "unlinked-write",
    orderSpec([{ name: "ship", impl: "src/admin.ts#shipOrder", to: "shipped" }]),
  );

  it("names writes no impl reaches after their function", () => {
    expect(result.model?.transitions.map((t) => t.name)).toEqual([
      "reopenOrder",
      "resetOrder",
      "resetOrder~2",
      "ship",
    ]);
    const t = transitionOf(result, "reopenOrder");
    expect(t).toMatchObject({
      from: ["paid"],
      to: "pending_payment",
      by: [],
      idempotent: false,
      atomic: true,
      impl: { file: "src/admin.ts", symbol: "reopenOrder" },
    });
    expect(t.sites?.specTransition).toBeUndefined();
    expect(guardKeys(t)).toEqual(["role(admin)"]);
    expect(result.model?.concurrency).toEqual({
      reopenOrder: 2,
      resetOrder: 2,
      "resetOrder~2": 2,
      ship: 2,
    });
  });

  it("dedups names by location and reports unguarded writes as unconstrained", () => {
    const first = transitionOf(result, "resetOrder");
    const second = transitionOf(result, "resetOrder~2");
    expect([first.to, second.to]).toEqual(["draft", "pending_payment"]);
    expect(first.sites?.fromState.unconstrained).toBe(true);
    expect(first.sites?.fromState.reason).toMatch(/full declared union/);
    expect(first.from).toEqual(orderSpec([]).entity.states);
    expect(first.atomic).toBe(false);
  });
});

describe("exact-union entity fallback", () => {
  const result = extractFixture("entity-fallback", orderSpec([]));

  it("an event typed with the spec's union is not the entity (assignment or spread)", () => {
    const names = result.model?.transitions.map((t) => t.name);
    expect(names).not.toContain("announceShipped");
    expect(names).not.toContain("announceRefunded");
  });

  it("matches another type name only when a bound read (through a helper) produced it", () => {
    const t = transitionOf(result, "shipRecord");
    expect(t.to).toBe("shipped");
    expect(t.from).toEqual(["paid"]);
    expect(t.sites?.read).toMatchObject({ gate: "db.orders.get", at: { line: 31 } });
    expect(t.atomic).toBe(true);
  });

  it("matches aliases of Pick<Order, …> and Readonly<Order> by name", () => {
    expect(result.model?.transitions.map((t) => [t.name, t.to])).toEqual([
      ["refundFrozen", "refunded"],
      ["shipRecord", "shipped"],
      ["shipRow", "shipped"],
    ]);
    expect(transitionOf(result, "shipRow").from).toEqual(["paid"]);
    expect(result.findings).toEqual([]);
  });
});

describe("string-typed status", () => {
  const spec = {
    ...orderSpec([]),
    name: "Tickets",
    entity: {
      name: "Ticket",
      stateField: "status",
      states: ["open", "resolved", "closed"],
      initial: "open",
      terminal: ["closed"],
    },
    transitions: [
      {
        name: "close",
        from: ["open", "resolved"],
        to: "closed",
        by: ["system"],
        requires: [],
        effects: [],
        atomic: false,
        idempotent: false,
        impl: { file: "src/tickets.ts", symbol: "closeTicket" },
      },
      {
        name: "resolve",
        from: ["open"],
        to: "resolved",
        by: ["system"],
        requires: [],
        effects: [],
        atomic: false,
        idempotent: false,
        impl: { file: "src/tickets.ts", symbol: "resolveTicket" },
      },
    ],
    concurrency: { close: 2, resolve: 2 },
    bindings: {
      persistence: "assign" as const,
      clients: { store: { module: "src/tickets.ts", export: "store" } },
      guards: {},
      effects: {},
    },
  };
  const result = extractFixture("string-status", spec);

  it("an unguarded write is `*` with a reason and an unanalyzable warning", () => {
    const t = transitionOf(result, "close");
    expect(t.from).toBe("*");
    expect(t.sites?.fromState).toEqual({
      values: "*",
      unconstrained: false,
      reason: "Ticket.status is typed string",
    });
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "unanalyzable:Tickets:from-state:close",
        category: "unanalyzable",
        severity: "warning",
        transition: "close",
        codeAt: expect.objectContaining({ file: "src/tickets.ts", line: 25 }),
      }),
    ]);
  });

  it("a guarded write still narrows to the literal", () => {
    const t = transitionOf(result, "resolve");
    expect(t.from).toEqual(["open"]);
    expect(t.sites?.fromState).toEqual({ values: ["open"], unconstrained: false });
    expect(t.sites?.storage).toEqual({ client: "store", collection: "tickets", key: "id" });
  });
});

describe("spread-to-save write", () => {
  const result = extractFixture(
    "spread-save",
    orderSpec([{ name: "refund", impl: "src/refund.ts#refundOrder", to: "refunded" }]),
  );

  it("extracts `{ ...order, status }` passed to save, with the call as the commit", () => {
    expect(result.model?.transitions.map((t) => t.name)).toEqual(["refund"]);
    const t = transitionOf(result, "refund");
    expect(t.sites?.write).toMatchObject({ file: "src/refund.ts", line: 9, column: 38 });
    expect(t.sites?.commit).toMatchObject({ gate: "db.orders.save", at: { line: 9 } });
    expect(t.atomic).toBe(true);
    expect(t.from).toEqual(["paid"]);
  });

  it("a non-literal target state is a warning, not a transition", () => {
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "unanalyzable:Fixture orders:write-value:setStatus",
        severity: "warning",
        codeAt: expect.objectContaining({ file: "src/refund.ts", line: 16, column: 36 }),
      }),
    ]);
  });
});

describe("unanalyzable ids", () => {
  const result = extractFixture("finding-ids", orderSpec([]));

  it("name the function (or file) instead of a position, suffixing collisions by location", () => {
    expect(result.findings.map((f) => [f.id, f.codeAt?.line])).toEqual([
      ["unanalyzable:Fixture orders:write-frame:seed", 7],
      ["unanalyzable:Fixture orders:write-value:setTwice", 12],
      ["unanalyzable:Fixture orders:write-value:setTwice~2", 13],
    ]);
  });
});

describe("broken impl link", () => {
  const at = (line: number) => ({ file: "fixture.behavior.yaml", line, column: 3 });
  const result = extractFixture(
    "broken-impl",
    orderSpec([
      { name: "ship", impl: "src/ship.ts#shipOrder", to: "shipped" },
      { name: "a_missing_file", impl: "src/missing.ts#ship", to: "shipped", at: at(10) },
      { name: "b_missing_symbol", impl: "src/ship.ts#nope", to: "shipped", at: at(20) },
      { name: "c_not_a_function", impl: "src/ship.ts#notAFunction", to: "shipped", at: at(30) },
    ]),
  );

  it("reports each unresolved impl as a broken-link error at the spec transition", () => {
    expect(result.findings.map((f) => [f.id, f.severity, f.transition, f.specAt?.line])).toEqual([
      ["broken-link:Fixture orders:impl:a_missing_file", "error", "a_missing_file", 10],
      ["broken-link:Fixture orders:impl:b_missing_symbol", "error", "b_missing_symbol", 20],
      ["broken-link:Fixture orders:impl:c_not_a_function", "error", "c_not_a_function", 30],
    ]);
    expect(result.findings[0]?.message).toMatch(
      /src\/missing\.ts is not part of the TypeScript project/,
    );
    expect(result.findings[1]?.message).toMatch(/no top-level symbol "nope"/);
    expect(result.findings[2]?.message).toMatch(/not a function/);
  });

  it("still extracts the links that resolve", () => {
    expect(result.model?.transitions.map((t) => t.name)).toEqual(["ship"]);
    expect(Object.keys(result.model?.implAt ?? {})).toEqual(["ship"]);
  });
});

describe("broken client binding", () => {
  const bindings = libBindings();
  // Unbound, the fake's body is ordinary project code and would be followed into `ledger`.
  delete bindings.clients.ledger;
  bindings.clients.stripe = {
    module: "../_lib/clients.ts",
    export: "stripee",
    at: { file: "f.yaml", line: 40, column: 5 },
  };
  bindings.clients.email = {
    module: "../_lib/mail.ts",
    export: "email",
    at: { file: "f.yaml", line: 41, column: 5 },
  };
  const roleAdmin = bindings.guards["role(admin)"];
  if (roleAdmin)
    bindings.guards["role(admin)"] = {
      ...roleAdmin,
      symbol: "requireRolez",
      at: { file: "f.yaml", line: 50, column: 5 },
    };
  const result = extractFixture(
    "broken-client",
    orderSpec([{ name: "refund", impl: "src/refund.ts#refundOrder", to: "refunded" }], bindings),
  );

  it("reports unresolved clients and guards as broken-link errors at the binding", () => {
    expect(result.findings.map((f) => [f.id, f.severity, f.specAt?.line])).toEqual([
      ["broken-link:Fixture orders:client:email", "error", 41],
      ["broken-link:Fixture orders:client:stripe", "error", 40],
      ["broken-link:Fixture orders:guard:role(admin)", "error", 50],
    ]);
    expect(result.findings[1]?.message).toMatch(/does not export "stripee"/);
  });

  it("does not recognize calls on the unresolved client or guard", () => {
    const t = transitionOf(result, "refund");
    expect(t.effects).toEqual([]);
    expect(t.requires).toEqual([]);
    expect(t.atomic).toBe(true);
  });
});

describe("extractAll", () => {
  it("returns one result per spec, in input order", () => {
    const a = {
      ...orderSpec([{ name: "ship", impl: "src/ship.ts#shipOrder", to: "shipped" }]),
      name: "B",
    };
    const b = { ...orderSpec([]), name: "A" };
    const { results, stats } = extractAll([a, b], {
      projectRoot: fixtureRoot("transaction-atomic"),
    });
    expect(results.map((r) => r.spec)).toEqual(["B", "A"]);
    expect(stats).toMatchObject({ files: 5, writes: 2, probes: 2 });
    // A spec without impls still sees every write, unlinked.
    expect(results[1]?.model?.transitions.map((t) => t.name)).toEqual([
      "shipBypassingTx",
      "shipOrder",
    ]);
  });

  it("reports a missing tsconfig as a broken-link error per spec", () => {
    const { results } = extractAll([orderSpec([])], { projectRoot: fixtureRoot("nope") });
    expect(results[0]?.model).toBeUndefined();
    expect(results[0]?.findings.map((f) => [f.id, f.severity])).toEqual([
      ["broken-link:Fixture orders:tsconfig", "error"],
    ]);
  });

  it("names the project directory and points at the spec file", () => {
    const spec = { ...orderSpec([]), file: "../specs/order.behavior.yaml" };
    const { results } = extractAll([spec], { projectRoot: fixtureRoot("nope") });
    const finding = results[0]?.findings[0];
    expect(finding?.message).toBe(
      `cannot load the TypeScript project: no tsconfig.json in the project directory ${fixtureRoot("nope")}, so the code behind \`impl\` and \`bindings\` can't be located`,
    );
    expect(finding?.specAt).toEqual({ file: "../specs/order.behavior.yaml", line: 1, column: 1 });
  });

  it("names an explicit tsconfig path that does not exist", () => {
    const { results } = extractAll([orderSpec([])], {
      projectRoot: fixtureRoot("transaction-atomic"),
      tsconfig: "tsconfig.missing.json",
    });
    expect(results[0]?.findings[0]?.message).toContain(
      `no tsconfig at ${fixtureRoot("transaction-atomic")}/tsconfig.missing.json`,
    );
  });

  it("does not extract with an adapter that does not exist yet", () => {
    const spec = orderSpec([]);
    spec.bindings.persistence = "prisma";
    const result = extractFixture("transaction-atomic", spec);
    expect(result.model).toBeUndefined();
    expect(result.findings.map((f) => [f.id, f.severity])).toEqual([
      ["unanalyzable:Fixture orders:persistence:prisma", "warning"],
    ]);
  });

  it("auto-detects assign when persistence is omitted", () => {
    const spec = orderSpec([{ name: "ship", impl: "src/ship.ts#shipOrder", to: "shipped" }]);
    delete spec.bindings.persistence;
    const result = extractFixture("transaction-atomic", spec);
    expect(transitionOf(result, "ship").sites?.persistence).toBe("assign");
  });
});
