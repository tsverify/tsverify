import type { Bindings } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import {
  expectOneUnanalyzablePerUnknownFrom,
  extractFixture,
  guardKeys,
  orderSpec,
  type TransitionSpec,
  transitionOf,
} from "./helpers";

const STATES = ["cancelled", "draft", "paid", "pending_payment", "refunded", "shipped"];

function prismaBindings(): Bindings {
  return {
    persistence: "prisma",
    clients: {
      db: { module: "../_prisma/db.ts", export: "prisma" },
      stripe: { module: "../_lib/clients.ts", export: "stripe" },
    },
    guards: {
      owner: {
        file: "../_prisma/guards.ts",
        symbol: "requireOwner",
        args: [],
        raw: "requireOwner",
      },
      "role(admin)": {
        file: "../_prisma/guards.ts",
        symbol: "requireRole",
        args: ["admin"],
        raw: '../_prisma/guards.ts#requireRole("admin")',
      },
    },
    effects: { "stripe.refund": "stripe.refunds.create" },
  };
}

const IMPL = "src/orders.ts";
const at = (name: string, to: string, from?: string[]): TransitionSpec => ({
  name,
  impl: `${IMPL}#${name}`,
  to,
  ...(from ? { from } : {}),
});

const transitions: TransitionSpec[] = [
  at("refundConditional", "refunded"),
  at("shipConditionalUpdate", "shipped"),
  at("expireIn", "cancelled", ["draft", "pending_payment"]),
  at("cancelNotIn", "cancelled", ["draft", "pending_payment", "paid"]),
  at("refundEquals", "refunded"),
  at("refundOr", "refunded"),
  at("refundRace", "refunded"),
  at("refundTxDefault", "refunded"),
  at("refundTxSerializable", "refunded"),
  at("shipTxSerializable", "shipped"),
  at("refundTxRepeatable", "refunded"),
  at("refundTxRootRead", "refunded"),
  at("refundArray", "refunded"),
  at("payBlind", "paid", ["pending_payment"]),
  at("shipUpsert", "shipped"),
  at("refundHelperRead", "refunded"),
  at("refundIncludes", "refunded"),
];

describe("prisma adapter", () => {
  const result = extractFixture("prisma-patterns", orderSpec(transitions, prismaBindings()));
  const t = (name: string) => transitionOf(result, name);

  it("extracts one write per update call on the Order model, and no create / other-model writes", () => {
    expect(result.model?.transitions.map((x) => x.name)).toEqual(
      transitions.map((x) => x.name).sort(),
    );
    for (const x of result.model?.transitions ?? []) expect(x.sites?.persistence).toBe("prisma");
  });

  describe("conditional updates: atomic, from-state from `where`", () => {
    it("updateMany with a literal status", () => {
      const r = t("refundConditional");
      expect(r.atomic).toBe(true);
      expect(r.from).toEqual(["paid"]);
      expect(r.sites?.fromState).toEqual({ values: ["paid"], unconstrained: false });
      expect(r.sites?.atomic).toMatchObject({
        kind: "conditional-update",
        gate: "db.order.updateMany",
        at: { file: IMPL, line: 9 },
      });
      expect(r.sites?.commit).toMatchObject({
        client: "db",
        path: "order.updateMany",
        gate: "db.order.updateMany",
        occurrence: 0,
      });
      expect(r.sites?.read).toBeUndefined();
      expect(r.sites?.storage).toEqual({ client: "db", collection: "order", key: "id" });
      expect(r.sites?.invocation).toEqual({
        impl: { file: IMPL, symbol: "refundConditional" },
        entityId: { param: 1, path: [] },
        actor: { param: 0, path: ["actor"] },
      });
      expect(guardKeys(r)).toEqual(["role(admin)"]);
      expect(r.effects).toEqual([{ name: "stripe.refund", multiplicity: "at-least-once" }]);
      expect(r.sites?.write).toMatchObject({ line: 11 });
    });

    it("update with a typed enum constant, and an enum-object written value", () => {
      const r = t("shipConditionalUpdate");
      expect(r).toMatchObject({ atomic: true, from: ["paid"], to: "shipped" });
      expect(r.sites?.atomic?.gate).toBe("db.order.update");
    });

    it.each([
      ["expireIn", ["draft", "pending_payment"]],
      ["cancelNotIn", ["draft", "pending_payment", "paid"]],
      ["refundEquals", ["paid"]],
    ])("%s: the filter's states", (name, from) => {
      expect(t(name)).toMatchObject({ atomic: true, from });
    });

    it("a `{ set: v }` write is the value v", () => {
      expect(t("refundEquals").to).toBe("refunded");
    });

    it("reports each unknown from-state once, as the extractor's unanalyzable", () => {
      expectOneUnanalyzablePerUnknownFrom(result);
    });

    it("a status condition inside OR: atomic, from-state unknown", () => {
      const r = t("refundOr");
      expect(r.atomic).toBe(true);
      expect(r.from).toBe("*");
      expect(r.sites?.fromState.reason).toContain("inside `OR`");
      expect(result.findings.map((f) => f.id)).toContain(
        "unanalyzable:Fixture orders:from-state:refundOr",
      );
    });

    it("upsert: the update branch, conditional on where", () => {
      expect(t("shipUpsert")).toMatchObject({ atomic: true, from: ["paid"], to: "shipped" });
    });
  });

  describe("read, then update", () => {
    it("a membership guard on the read narrows the update's from-state", () => {
      const r = t("refundIncludes");
      expect(r).toMatchObject({ atomic: false, from: ["paid", "shipped"] });
      expect(r.sites?.fromState).toEqual({ values: ["paid", "shipped"], unconstrained: false });
    });

    it("findUnique → check → update outside a transaction: not atomic, narrowed from-state", () => {
      const r = t("refundRace");
      expect(r.atomic).toBe(false);
      expect(r.sites?.atomic).toBeUndefined();
      expect(r.from).toEqual(["paid"]);
      expect(r.sites?.fromState).toEqual({ values: ["paid"], unconstrained: false });
      expect(r.sites?.read).toMatchObject({ gate: "db.order.findUnique", at: { line: 57 } });
      expect(r.sites?.commit).toMatchObject({ gate: "db.order.update", at: { line: 60 } });
      expect(r.sites?.invocation?.entityId).toEqual({ param: 0, path: [] });
    });

    it("interactive $transaction at the default level: not atomic, with an isolation note", () => {
      const r = t("refundTxDefault");
      expect(r.atomic).toBe(false);
      expect(r.sites?.read?.gate).toBe("db.order.findUniqueOrThrow");
      expect(r.sites?.commit?.gate).toBe("db.order.update");
      const note = r.sites?.atomicNote;
      expect(note?.at).toMatchObject({ file: IMPL, line: 65 });
      expect(note?.message).toContain("default isolation level (READ COMMITTED on PostgreSQL)");
      expect(note?.hint).toContain("updateMany");
      expect(note?.hint).toContain("Serializable");
    });

    it.each(["refundTxSerializable", "shipTxSerializable"])(
      "%s: Serializable interactive transaction is atomic",
      (name) => {
        const r = t(name);
        expect(r.atomic).toBe(true);
        expect(r.sites?.atomic).toMatchObject({ kind: "transaction", gate: "db.$transaction" });
        expect(r.from).toEqual(["paid"]);
      },
    );

    it("guards inside the transaction callback still dominate", () => {
      expect(guardKeys(t("shipTxSerializable"))).toEqual(["owner"]);
      expect(t("shipTxSerializable").sites?.invocation?.actor).toEqual({
        param: 0,
        path: ["actor"],
      });
    });

    it("RepeatableRead is not Serializable", () => {
      expect(t("refundTxRepeatable").atomic).toBe(false);
      expect(t("refundTxRepeatable").sites?.atomicNote?.message).toContain(
        "isolation level RepeatableRead",
      );
    });

    it("a read through the root client inside a Serializable transaction is outside it", () => {
      const r = t("refundTxRootRead");
      expect(r.atomic).toBe(false);
      expect(r.sites?.read?.gate).toBe("db.order.findUniqueOrThrow");
    });

    it("the array form of $transaction is not atomic", () => {
      const r = t("refundArray");
      expect(r.atomic).toBe(false);
      expect(r.from).toEqual(["paid"]);
      expect(r.sites?.atomicNote?.message).toContain("array form of db.$transaction");
    });

    it("a read hidden in a helper, named by `where: { id: order.id }`", () => {
      const r = t("refundHelperRead");
      expect(r.atomic).toBe(false);
      expect(r.from).toEqual(["paid"]);
      expect(r.sites?.read).toMatchObject({
        gate: "db.order.findUniqueOrThrow",
        at: { line: 158 },
      });
    });
  });

  it("a blind update (no read, no status condition) is atomic and unconstrained", () => {
    const r = t("payBlind");
    expect(r.atomic).toBe(true);
    expect(r.from).toEqual(orderSpec([]).entity.states);
    expect(r.sites?.fromState).toMatchObject({ values: STATES, unconstrained: true });
    expect(r.sites?.fromState.reason).toContain("no `status` condition");
    expect(r.sites?.invocation?.entityId).toEqual({ param: 0, path: ["orderId"] });
  });

  it("reports only the OR from-state (atomicity notes live on the sites)", () => {
    expect(result.findings.map((f) => `${f.severity} ${f.id}`)).toEqual([
      "warning unanalyzable:Fixture orders:from-state:refundOr",
    ]);
  });

  it("puts no note on atomic writes", () => {
    for (const name of ["refundTxSerializable", "shipTxSerializable", "payBlind"]) {
      expect(t(name).sites?.atomicNote).toBeUndefined();
    }
  });
});

describe("prisma auto-detection", () => {
  it("detects an @prisma/client import", () => {
    const bindings = prismaBindings();
    delete bindings.persistence;
    bindings.clients = { db: { module: "src/db.ts", export: "prisma" } };
    bindings.guards = {};
    const spec = orderSpec(
      [{ name: "ship", impl: "src/db.ts#shipOrder", to: "shipped" }],
      bindings,
    );
    const result = extractFixture("prisma-detect", spec);
    expect(result.findings).toEqual([]);
    expect(transitionOf(result, "ship")).toMatchObject({
      atomic: true,
      from: ["paid"],
      sites: { persistence: "prisma", atomic: { kind: "conditional-update" } },
    });
  });

  it("detects an import of PrismaClient from a generated module", () => {
    const bindings = prismaBindings();
    delete bindings.persistence;
    const result = extractFixture(
      "prisma-patterns",
      orderSpec([at("refundConditional", "refunded")], bindings),
    );
    expect(transitionOf(result, "refundConditional").sites?.persistence).toBe("prisma");
  });

  it("an assign spec ignores Prisma update calls", () => {
    const bindings = prismaBindings();
    bindings.persistence = "assign";
    const result = extractFixture(
      "prisma-patterns",
      orderSpec([at("refundConditional", "refunded")], bindings),
    );
    expect(result.model?.transitions.map((x) => x.sites?.persistence)).toEqual([]);
  });
});

describe("prisma: an update object held in a variable", () => {
  const held = (name: string, to: string, from?: string[]): TransitionSpec => ({
    name,
    impl: `src/orders.ts#${name}`,
    to,
    ...(from ? { from } : {}),
  });
  const result = extractFixture(
    "prisma-held",
    orderSpec(
      [
        held("refundHeld", "refunded"),
        held("shipHeld", "shipped"),
        held("cancelHeldLet", "cancelled"),
        held("cancelHeldLater", "cancelled"),
        held("payHeldTwice", "paid", ["pending_payment"]),
      ],
      prismaBindings(),
    ),
  );
  const finding = (id: string) => result.findings.find((f) => f.id === id);

  it("a `const` used only as the update's `data` is read as if written into the call", () => {
    const r = transitionOf(result, "refundHeld");
    expect(r).toMatchObject({ from: ["paid"], to: "refunded", atomic: false });
    expect(r.sites).toMatchObject({
      write: { line: 7 },
      read: { gate: "db.order.findUnique" },
      commit: { gate: "db.order.update", at: { line: 8 } },
    });
    const s = transitionOf(result, "shipHeld");
    expect(s).toMatchObject({ from: ["paid"], to: "shipped", atomic: true });
    expect(s.sites?.atomic).toMatchObject({
      kind: "conditional-update",
      gate: "db.order.updateMany",
    });
  });

  it("reports any other held update object, and extracts nothing from it", () => {
    expect(finding("unanalyzable:Fixture orders:write-shape:cancelHeldLet")?.message).toMatch(
      /^Order\.status is set in `data`, an object later passed to `prisma\.order\.update`, but `data` is not a `const`, `data` is also used in `data = \{ \.\.\.data \}`.*; the write is not extracted$/,
    );
    expect(finding("unanalyzable:Fixture orders:write-shape:cancelHeldLater")?.message).toContain(
      "but `data.status` is set after the object is built",
    );
    expect(finding("unanalyzable:Fixture orders:write-shape:payHeldTwice")?.message).toContain(
      "but `data` is the update object of 2 calls",
    );
    const sited = (result.model?.transitions ?? []).filter((t) => t.sites !== undefined);
    expect(sited.map((t) => t.name)).toEqual(["refundHeld", "shipHeld"]);
    // Each impl that reaches one is unconfirmed, not missing.
    expect(Object.keys(result.model?.unreadWrites ?? {})).toEqual([
      "cancelHeldLater",
      "cancelHeldLet",
      "payHeldTwice",
    ]);
  });

  it("an object that never reaches an update is not a write", () => {
    expect(result.findings.some((f) => f.id.includes("view"))).toBe(false);
  });
});
