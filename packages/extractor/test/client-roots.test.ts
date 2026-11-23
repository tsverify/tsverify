import { describe, expect, it } from "vitest";
import { extractFixture, libBindings, orderSpec, transition, transitionOf } from "./helpers";

function effectSites(name: string, result: ReturnType<typeof extractFixture>) {
  return transitionOf(result, name).sites?.effects.map((e) => [e.effect, e.gate, e.path]);
}

describe("effects through a bare exported function", () => {
  const ships = ["shipViaReexport", "shipViaAlias", "shipViaNamespace"];
  const spec = (module: string) => {
    const bindings = libBindings();
    bindings.clients = {
      db: bindings.clients.db as (typeof bindings.clients)[string],
      email: { module, export: "sendMail" },
    };
    bindings.effects = { "email.welcome": "email" };
    return orderSpec(
      ships.map((n) => ({
        name: n,
        impl: `src/ship.ts#${n}`,
        to: "shipped",
        effects: [{ name: "email.welcome", multiplicity: "exactly-once" }],
      })),
      bindings,
    );
  };

  for (const module of ["src/notify/email.ts", "src/notify/index.ts"]) {
    describe(`bound at ${module}`, () => {
      const result = extractFixture("effect-function", spec(module));

      it.each(ships)("%s: a direct call is an effect call gated by the client name", (name) => {
        expect(effectSites(name, result)).toEqual([["email.welcome", "email", ""]]);
        expect(transitionOf(result, name).effects).toEqual([
          { name: "email.welcome", multiplicity: "exactly-once" },
        ]);
      });
    });
  }

  it("leaves an unmapped bare client call gated by the client name", () => {
    const s = spec("src/notify/email.ts");
    s.bindings.effects = {};
    const result = extractFixture("effect-function", s);
    expect(effectSites("shipViaAlias", result)).toEqual([["email", "email", ""]]);
  });
});

describe("injected clients (by declared type)", () => {
  describe("prisma: a service class with constructor injection", () => {
    const bindings = libBindings();
    bindings.persistence = "prisma";
    bindings.clients = {
      db: { module: "../_prisma/db.ts", export: "prisma" },
      stripe: { module: "../_lib/clients.ts", export: "stripe" },
    };
    bindings.effects = { "stripe.refund": "stripe.refunds.create" };
    const impl = (m: string) => `src/order-service.ts#OrderService.${m}`;
    const result = extractFixture(
      "injected-prisma",
      orderSpec(
        [
          { name: "ship", impl: impl("ship"), to: "shipped" },
          { name: "refund", impl: impl("refund"), to: "refunded" },
          { name: "cancel", impl: impl("cancel"), to: "cancelled", from: ["draft"] },
        ],
        bindings,
      ),
    );
    const t = (name: string) => transitionOf(result, name);

    it("finds every write through `this.prisma` / `this.db`", () => {
      expect(result.model?.transitions.map((x) => x.name)).toEqual(["cancel", "refund", "ship"]);
    });

    it("a parameter property: conditional update, atomic, from-state from `where`", () => {
      expect(t("ship")).toMatchObject({ atomic: true, from: ["paid"], to: "shipped" });
      expect(t("ship").sites?.atomic?.gate).toBe("db.order.update");
    });

    it("read and commit through the field, effect through an injected SDK", () => {
      const r = t("refund");
      expect(r).toMatchObject({ atomic: false, from: ["paid"] });
      expect(r.sites?.read?.gate).toBe("db.order.findUnique");
      expect(r.sites?.commit?.gate).toBe("db.order.update");
      expect(effectSites("refund", result)).toEqual([
        ["stripe.refund", "stripe.refunds.create", "refunds.create"],
      ]);
    });

    it("a field assigned in the constructor opens the transaction scope", () => {
      const r = t("cancel");
      expect(r).toMatchObject({ atomic: true, from: ["draft"] });
      expect(r.sites?.read?.gate).toBe("db.order.findUniqueOrThrow");
    });
  });

  describe("assign: `deps` parameter and destructured context", () => {
    const result = extractFixture(
      "injected-assign",
      orderSpec([
        { name: "ship", impl: "src/deps.ts#shipWithDeps", to: "shipped" },
        { name: "refund", impl: "src/deps.ts#refundWithContext", to: "refunded" },
      ]),
    );

    it("`deps.db.transaction` scopes the read and commit; `deps.email.send` is an effect", () => {
      const r = transitionOf(result, "ship");
      expect(r).toMatchObject({ atomic: true, from: ["paid"] });
      expect(r.sites?.read?.gate).toBe("db.orders.get");
      expect(r.sites?.storage).toEqual({ client: "db", collection: "orders", key: "id" });
      expect(effectSites("ship", result)).toEqual([["email.receipt", "email.send", "send"]]);
    });

    it("a destructured binding typed as the client's interface; a look-alike type is not a client", () => {
      const r = transitionOf(result, "refund");
      expect(r).toMatchObject({ atomic: false, from: ["paid"] });
      expect(r.sites?.read?.gate).toBe("db.orders.get");
      expect(r.sites?.commit?.gate).toBe("db.orders.save");
      expect(effectSites("refund", result)).toEqual([["audit.log", "audit.log", "log"]]);
    });
  });

  describe("memory: an entity class with an injected event bus", () => {
    const bindings = libBindings();
    bindings.persistence = "memory";
    bindings.clients = { bus: { module: "src/bus.ts", export: "bus" } };
    bindings.guards = {};
    bindings.effects = { "job.started": "bus.publish" };
    const spec = orderSpec([], bindings);
    spec.entity = {
      name: "Worker",
      stateField: "status",
      states: ["done", "failed", "queued", "running"],
      initial: "queued",
      terminal: ["done", "failed"],
    };
    spec.transitions = [
      transition({
        name: "start",
        impl: "src/worker.ts#Worker.start",
        from: ["queued"],
        to: "running",
        effects: [{ name: "job.started", multiplicity: "at-least-once" }],
      }),
    ];
    const result = extractFixture("injected-memory", spec);

    it("`this.bus.publish` is the bound effect; `this.tracer.publish` (another type) is not", () => {
      expect(effectSites("start", result)).toEqual([["job.started", "bus.publish", "publish"]]);
      expect(transitionOf(result, "start")).toMatchObject({ atomic: true, from: ["queued"] });
    });

    it("matches no client when two bound clients share the receiver's type", () => {
      const both = structuredClone(spec);
      both.bindings.clients.audit = { module: "src/bus.ts", export: "auditBus" };
      expect(effectSites("start", extractFixture("injected-memory", both))).toEqual([]);
    });
  });
});

describe("a client bound to a class, and bound clients nothing calls", () => {
  const bindings = libBindings();
  const specAt = { file: "fixture.behavior.yaml", line: 40, column: 5 };
  bindings.clients = {
    db: bindings.clients.db as (typeof bindings.clients)[string],
    queue: { module: "src/queue.ts", export: "Queue" },
    notifier: { module: "src/queue.ts", export: "Notifier" },
    audit: { module: "src/queue.ts", export: "audit", at: specAt },
  };
  bindings.effects = {
    "queue.ack_ship": "queue.ack",
    "audit.shipped": "audit.log",
    "notifier.shipped": "notifier.notify",
  };
  const result = extractFixture(
    "injected-class",
    orderSpec(
      [
        {
          name: "ship",
          impl: "src/service.ts#Service.ship",
          to: "shipped",
          effects: [
            { name: "audit.shipped", multiplicity: "at-least-once" },
            { name: "queue.ack_ship", multiplicity: "exactly-once" },
            { name: "notifier.shipped", multiplicity: "at-least-once" },
          ],
        },
      ],
      bindings,
    ),
    { bindingWarnings: true },
  );

  it("a call on an instance typed as the class (`this.$.queue.ack`) is a call on the client", () => {
    expect(effectSites("ship", result)).toContainEqual(["queue.ack_ship", "queue.ack", "ack"]);
  });

  it("a client bound to an interface: a call on a value typed as it is a call on the client", () => {
    expect(effectSites("ship", result)).toContainEqual([
      "notifier.shipped",
      "notifier.notify",
      "notify",
    ]);
  });

  it("a method that only reads is an effect, no spec effect maps to it, until listed under `reads`", () => {
    expect(effectSites("ship", result)).toContainEqual([
      "queue.isPaused",
      "queue.isPaused",
      "isPaused",
    ]);
    expect(transitionOf(result, "ship").effects).toContainEqual({
      name: "queue.isPaused",
      multiplicity: "at-least-once",
      unmapped: true,
    });
    const withReads = structuredClone(bindings);
    (withReads.clients.queue as { reads?: string[] }).reads = ["isPaused"];
    const read = extractFixture(
      "injected-class",
      orderSpec(
        [
          {
            name: "ship",
            impl: "src/service.ts#Service.ship",
            to: "shipped",
            effects: [{ name: "queue.ack_ship", multiplicity: "exactly-once" }],
          },
        ],
        withReads,
      ),
    );
    expect(effectSites("ship", read)).toEqual([
      ["queue.ack_ship", "queue.ack", "ack"],
      ["notifier.shipped", "notifier.notify", "notify"],
    ]);
  });

  it("warns about a bound client that no call resolves to, at its binding", () => {
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "unanalyzable:Fixture orders:binding:audit",
        severity: "warning",
        message:
          'client "audit" (src/queue.ts#audit) is bound but never called: no call in the project resolves to it, so tsverify sees none of its calls',
        specAt,
      }),
    ]);
    expect(result.model?.uncalledClients).toEqual({
      audit: "unanalyzable:Fixture orders:binding:audit",
    });
  });

  it("tells `tsverify test` what it can't call or fake: an instance method, a class", () => {
    expect(result.model?.instanceImpls).toEqual(["ship"]);
    expect(result.model?.unfakeable).toEqual([
      {
        binding: "clients.notifier",
        reason:
          "client notifier is the interface Notifier, a type: there is no module export to replace with a fake, and the code gets its instances from elsewhere",
      },
      {
        binding: "clients.queue",
        reason:
          "client queue is the class Queue, and a fake object in its place would break `new Queue(…)`",
      },
    ]);
  });

  it("takes the effects on that client as specified (they can't be seen)", () => {
    const ship = transitionOf(result, "ship");
    expect(ship.effects.map((e) => e.name)).toEqual([
      "audit.shipped",
      "notifier.shipped",
      "queue.ack_ship",
      "queue.isPaused",
    ]);
    expect(ship.sites?.effects.map((e) => e.effect)).toEqual([
      "queue.isPaused",
      "queue.ack_ship",
      "notifier.shipped",
    ]);
  });
});
