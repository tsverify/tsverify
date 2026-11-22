import { describe, expect, test } from "vitest";
import { scheduler } from "../scheduler";
import { prismaConfigFromCode } from "../sites";
import { PrismaFakeError, prisma } from "./prisma";
import { UninstrumentedCallError } from "./strict";

const paid = { id: "o1", status: "paid", chargeId: "ch_1", total: 10 };

function setup() {
  const s = scheduler();
  const db = prisma(s, {
    client: "db",
    models: { order: { key: "id", seed: [paid] } },
    read: ["order.findUnique"],
    write: ["order.update", "order.updateMany"],
  });
  return { s, db, order: db.client.order };
}

/** The refund shapes, written the way an app would against a real PrismaClient. */
function refunds(db: ReturnType<typeof setup>["db"], log: string[]) {
  const c = db.client;
  return {
    /** Read, check, then a plain update: the B3 race. */
    async readThenUpdate(options?: { isolationLevel: string }) {
      const run = async (tx: typeof c) => {
        const o = (await tx.order.findUnique({ where: { id: "o1" } })) as { status: string } | null;
        if (o?.status !== "paid") throw new Error("not paid");
        await tx.order.update({ where: { id: "o1" }, data: { status: "refunded" } });
        log.push("refunded");
      };
      if (options === undefined) return run(c);
      return c.$transaction((tx) => run(tx as typeof c), options);
    },
    /** A conditional updateMany: one statement. */
    async conditional() {
      const { count } = (await c.order.updateMany({
        where: { id: "o1", status: "paid" },
        data: { status: "refunded" },
      })) as { count: number };
      if (count === 0) throw new Error("not paid");
      log.push("refunded");
    },
  };
}

const RACE = [
  ["w1", "db.order.findUnique"],
  ["w2", "db.order.findUnique"],
  ["w1", "db.order.update"],
  ["w2", "db.order.update"],
  ["w1", "until-done"],
  ["w2", "until-done"],
] as const;

describe("instrument.prisma: delegate semantics", () => {
  test("sync gates for read/write paths, transparent gates for every other method", () => {
    const { s } = setup();
    const gates = s.knownGates();
    expect(gates).toContain("db.order.findUniqueOrThrow");
    expect(gates).toContain("db.$transaction");
    expect(gates).toHaveLength(13);
  });

  test("where filters, data operations and select", async () => {
    const { db, order } = setup();
    db.seed({ order: [{ id: "o2", status: "draft", total: 5 }] });
    expect(await order.count({ where: { status: { in: ["paid", "draft"] } } })).toBe(2);
    expect(await order.count({ where: { status: { not: "paid" } } })).toBe(1);
    expect(await order.count({ where: { OR: [{ id: "o1" }, { total: { gte: 5, lt: 6 } }] } })).toBe(
      2,
    );
    expect(await order.count({ where: { NOT: { status: "paid" }, id: { startsWith: "o" } } })).toBe(
      1,
    );
    expect(
      await order.update({
        where: { id: "o1" },
        data: { total: { increment: 5 } },
        select: { total: true },
      }),
    ).toEqual({ total: 15 });
    expect(await order.findMany({ where: { status: { notIn: ["paid"] } } })).toEqual([
      { id: "o2", status: "draft", total: 5 },
    ]);
    expect(db.read("order", "o1")).toMatchObject({ total: 15 });
  });

  test("missing rows: null, P2025, or count 0; duplicate create: P2002", async () => {
    const { order } = setup();
    expect(await order.findUnique({ where: { id: "nope" } })).toBeNull();
    await expect(order.findUniqueOrThrow({ where: { id: "nope" } })).rejects.toMatchObject({
      name: "PrismaClientKnownRequestError",
      code: "P2025",
    });
    await expect(
      order.update({ where: { id: "o1", status: "draft" }, data: { status: "paid" } }),
    ).rejects.toBeInstanceOf(PrismaFakeError);
    expect(await order.updateMany({ where: { status: "draft" }, data: { status: "x" } })).toEqual({
      count: 0,
    });
    await expect(order.create({ data: { id: "o1" } })).rejects.toMatchObject({ code: "P2002" });
    expect(await order.create({ data: { status: "draft" } })).toEqual({
      id: "order_2",
      status: "draft",
    });
  });

  test("upsert updates a match and creates otherwise; delete removes", async () => {
    const { db, order } = setup();
    await order.upsert({
      where: { id: "o1" },
      create: { id: "o1" },
      update: { status: "shipped" },
    });
    await order.upsert({ where: { id: "o3" }, create: { id: "o3", status: "draft" }, update: {} });
    expect(db.rows("order").map((r) => `${r.id}:${r.status}`)).toEqual(["o1:shipped", "o3:draft"]);
    await order.delete({ where: { id: "o3" } });
    expect(await order.deleteMany({ where: {} })).toEqual({ count: 1 });
    expect(db.rows("order")).toEqual([]);
  });

  test("copy on read and on write", async () => {
    const { db, order } = setup();
    const row = (await order.findUnique({ where: { id: "o1" } })) as Record<string, unknown>;
    row.total = 99;
    expect(db.read("order", "o1")).toEqual(paid);
  });

  test("calls are lazy PrismaPromises: nothing runs until awaited", async () => {
    const { db, order } = setup();
    const pending = order.update({ where: { id: "o1" }, data: { status: "refunded" } });
    expect(db.read("order", "o1")).toMatchObject({ status: "paid" });
    expect(Object.prototype.toString.call(pending)).toBe("[object PrismaPromise]");
    await pending;
    expect(db.read("order", "o1")).toMatchObject({ status: "refunded" });
  });

  test("relations and unknown members fail with the fix", async () => {
    const { db, order } = setup();
    await expect(
      order.findUnique({ where: { id: "o1" }, include: { lines: true } }),
    ).rejects.toThrow("does not support `include` (relations)");
    await expect(
      order.update({ where: { id: "o1" }, data: { lines: { create: { sku: "a" } } } }),
    ).rejects.toThrow('the nested write "create" on "lines"');
    const client = db.client as unknown as Record<string, Record<string, () => unknown>>;
    expect(() => client.payment?.findUnique?.()).toThrow(UninstrumentedCallError);
    expect(() => client.payment?.findUnique?.()).toThrow(
      'If "payment" is a model, add `payment: { key: "id" }` to `models`.',
    );
    expect(() => (db.client as unknown as Record<string, () => unknown>).$queryRaw?.()).toThrow(
      "$queryRaw (raw SQL, extensions, middleware) is not modelled",
    );
    await db.client.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, () => unknown>;
      expect(() => t.$transaction?.()).toThrow("has no $transaction (transactions do not nest)");
    });
  });

  test("bad configs fail with the fix", () => {
    expect(() =>
      prisma(scheduler(), {
        client: "db",
        models: { order: { key: "id" } },
        read: ["order.get"],
        write: [],
      }),
    ).toThrow('read path "order.get" must be "<model>.<method>" with a Prisma delegate method');
    expect(() =>
      prisma(scheduler(), {
        client: "db",
        models: { order: { key: "id" } },
        read: ["user.findUnique"],
        write: [],
      }),
    ).toThrow('prisma fake "db" has no model "user" (models: order)');
  });
});

describe("instrument.prisma: transactions", () => {
  test("interactive: commit on resolve, undo on throw", async () => {
    const { db } = setup();
    await expect(
      db.client.$transaction(async (tx) => {
        await tx.order.update({ where: { id: "o1" }, data: { status: "refunded" } });
        await tx.order.create({ data: { id: "o9" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.rows("order")).toEqual([paid]);
    await db.client.$transaction(async (tx) => {
      await tx.order.update({ where: { id: "o1" }, data: { status: "refunded" } });
    });
    expect(db.read("order", "o1")).toMatchObject({ status: "refunded" });
  });

  test("array form: runs in order, returns the results, undoes everything on failure", async () => {
    const { db, order } = setup();
    await expect(
      db.client.$transaction([
        order.update({ where: { id: "o1" }, data: { status: "refunded" } }),
        order.update({ where: { id: "nope" }, data: { status: "refunded" } }),
      ]),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(db.rows("order")).toEqual([paid]);
    expect(
      await db.client.$transaction([
        order.updateMany({ where: { status: "paid" }, data: { status: "refunded" } }),
        order.count({ where: { status: "refunded" } }),
      ]),
    ).toEqual([{ count: 1 }, 1]);
    await expect(db.client.$transaction([Promise.resolve(1)])).rejects.toThrow(
      "every element must be a call on this client",
    );
  });

  test("read-then-update without a transaction: the replay shows the race", async () => {
    const { s, db } = setup();
    const log: string[] = [];
    const r = refunds(db, log);
    s.spawn("w1", () => r.readThenUpdate());
    s.spawn("w2", () => r.readThenUpdate());
    await s.play(RACE.map((x) => [...x]));
    expect(log).toEqual(["refunded", "refunded"]);
  });

  test("read-then-update in a default-isolation $transaction: no lock, still races", async () => {
    const { s, db } = setup();
    const log: string[] = [];
    const r = refunds(db, log);
    s.spawn("w1", () => r.readThenUpdate({ isolationLevel: "ReadCommitted" }));
    s.spawn("w2", () => r.readThenUpdate({ isolationLevel: "ReadCommitted" }));
    await s.play(RACE.map((x) => [...x]));
    expect(log).toEqual(["refunded", "refunded"]);
    expect(s.gateLog().map((g) => `${g.worker}:${g.gate}`)).toEqual([
      "w1:db.$transaction",
      "w1:db.order.findUnique",
      "w2:db.$transaction",
      "w2:db.order.findUnique",
      "w1:db.order.update",
      "w2:db.order.update",
    ]);
  });

  test("a Serializable $transaction holds the lock: the second worker is blocked", async () => {
    const { s, db } = setup();
    const log: string[] = [];
    const r = refunds(db, log);
    s.spawn("w1", () => r.readThenUpdate({ isolationLevel: "Serializable" }));
    s.spawn("w2", () => r.readThenUpdate({ isolationLevel: "Serializable" }));
    const outcome = await s.tryPlay(RACE.map((x) => [...x]));
    expect(outcome.followed).toBe(false);
    if (!outcome.followed) expect(outcome.divergence.details.kind).toBe("blocked");
    await s.drain();
    expect(log).toEqual(["refunded"]);
    expect(s.outcome("w2")).toMatchObject({ status: "failed" });
  });

  test("a conditional updateMany is one compare-and-set: only one worker wins", async () => {
    const { s, db } = setup();
    const log: string[] = [];
    const r = refunds(db, log);
    s.spawn("w1", () => r.conditional());
    s.spawn("w2", () => r.conditional());
    await s.play([
      ["w1", "db.order.updateMany"],
      ["w2", "db.order.updateMany"],
      ["w1", "until-done"],
      ["w2", "until-done"],
    ]);
    expect(log).toEqual(["refunded"]);
    expect(s.outcome("w1")).toMatchObject({ status: "done" });
    expect(s.outcome("w2")).toMatchObject({ status: "failed" });
    expect(db.read("order", "o1")).toMatchObject({ status: "refunded" });
  });

  test("calls made in a worker but awaited by $transaction([…]) run in that worker", async () => {
    const { s, db, order } = setup();
    s.spawn("w1", async () => {
      const update = order.update({ where: { id: "o1" }, data: { status: "refunded" } });
      await db.client.$transaction([update]);
    });
    await s.play([
      ["w1", "db.order.update"],
      ["w1", "until-done"],
    ]);
    expect(s.gateLog().map((g) => `${g.worker}:${g.gate}`)).toEqual([
      "w1:db.$transaction",
      "w1:db.order.update",
    ]);
  });
});

describe("prismaConfigFromCode", () => {
  test("models from storage, sync paths from read and commit sites", () => {
    const site = (path: string) => ({ client: "db", path, gate: `db.${path}`, occurrence: 0 });
    const config = prismaConfigFromCode(
      {
        transitions: [
          {
            name: "refund",
            sites: {
              read: site("order.findUnique"),
              commit: site("order.update"),
              effects: [],
              storage: { client: "db", collection: "order", key: "id" },
            },
          },
          { name: "ship", sites: { commit: site("order.updateMany"), effects: [] } },
          { name: "audit", sites: { commit: site("auditLog.create"), effects: [] } },
          { name: "other", sites: { commit: { ...site("x.y"), client: "cache" }, effects: [] } },
        ],
      },
      "db",
    );
    expect(config).toEqual({
      client: "db",
      models: { order: { key: "id" }, auditLog: { key: "id" } },
      read: ["order.findUnique"],
      write: ["auditLog.create", "order.update", "order.updateMany"],
    });
  });
});
