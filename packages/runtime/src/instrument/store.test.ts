import { describe, expect, test } from "vitest";
import { scheduler } from "../scheduler";
import { store } from "./store";
import { UninstrumentedCallError } from "./strict";

class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

function setup() {
  const s = scheduler();
  const db = store(s, {
    client: "db",
    collections: {
      orders: { key: "id", seed: [{ id: "o1", status: "paid", lines: [{ sku: "a" }] }] },
      users: { key: "uid" },
    },
    read: ["orders.get", "users.byId"],
    commit: ["orders.save"],
    transaction: "transaction",
  });
  return { s, db };
}

describe("instrument.store", () => {
  test("defines sync gates for read/commit paths and a transparent transaction gate", () => {
    const { s } = setup();
    expect(s.knownGates()).toEqual([
      "db.orders.get",
      "db.users.byId",
      "db.orders.save",
      "db.transaction",
    ]);
  });

  test("copy on read and copy on write: the code never holds a reference into the store", async () => {
    const { db } = setup();
    const row = await db.client.orders.get("o1");
    if (!row) throw new Error("seeded row missing");
    (row.lines as { sku: string }[]).push({ sku: "b" });
    row.status = "mutated";
    expect(db.read("orders", "o1")).toEqual({ id: "o1", status: "paid", lines: [{ sku: "a" }] });

    const order = { id: "o2", status: "draft" };
    await db.client.orders.save(order);
    order.status = "mutated";
    expect(db.read("orders", "o2")).toEqual({ id: "o2", status: "draft" });
    expect(db.rows("orders").map((r) => r.id)).toEqual(["o1", "o2"]);
  });

  test("config seeds come back on every reset; seed() rows last for one run", async () => {
    const { s, db } = setup();
    db.seed({ orders: [{ id: "o1", status: "refunded" }, { id: "o9" }], users: [{ uid: "u1" }] });
    expect(db.read("orders", "o1")).toEqual({ id: "o1", status: "refunded" });
    expect(await db.client.users.byId("u1")).toEqual({ uid: "u1" });
    s.reset();
    expect(db.rows("orders")).toEqual([{ id: "o1", status: "paid", lines: [{ sku: "a" }] }]);
    expect(db.rows("users")).toEqual([]);
  });

  test("transaction: reads see staged writes, commit applies them, others see them only after", async () => {
    const { db } = setup();
    const result = await db.client.transaction(async (tx) => {
      const order = await tx.orders.get("o1");
      await tx.orders.save({ ...order, status: "refunded" });
      expect(await tx.orders.get("o1")).toMatchObject({ status: "refunded" });
      expect(db.read("orders", "o1")).toMatchObject({ status: "paid" }); // not committed yet
      expect(await db.client.orders.get("o1")).toMatchObject({ status: "paid" });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(db.read("orders", "o1")).toMatchObject({ status: "refunded" });
  });

  test("transaction: a throw rolls back every staged write and rethrows", async () => {
    const { db } = setup();
    await expect(
      db.client.transaction(async (tx) => {
        await tx.orders.save({ id: "o1", status: "refunded" });
        await tx.orders.save({ id: "o3", status: "draft" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.rows("orders")).toEqual([{ id: "o1", status: "paid", lines: [{ sku: "a" }] }]);
  });

  test("transaction: one at a time, also outside workers (a serialized mutex)", async () => {
    const { db } = setup();
    const events: string[] = [];
    const tx = (name: string) =>
      db.client.transaction(async (t) => {
        events.push(`${name} begin`);
        const o = await t.orders.get("o1");
        await new Promise((r) => setImmediate(r));
        await t.orders.save({ ...o, status: `${o?.status}+${name}` });
        events.push(`${name} end`);
      });
    await Promise.all([tx("a"), tx("b")]);
    expect(events).toEqual(["a begin", "a end", "b begin", "b end"]);
    expect(db.read("orders", "o1")).toMatchObject({ status: "paid+a+b" });
  });

  test("missing rows: undefined by default, or the configured error", async () => {
    const { db } = setup();
    expect(await db.client.orders.get("nope")).toBeUndefined();
    const s = scheduler();
    const strict = store(s, {
      client: "db",
      collections: { orders: { key: "id" } },
      read: ["orders.get"],
      commit: [],
      missing: (collection, key) => new NotFoundError(`${collection} ${key} not found`),
    });
    await expect(strict.client.orders.get("nope")).rejects.toThrow(NotFoundError);
    await expect(strict.client.orders.get(7)).rejects.toThrow("orders 7 not found");
  });

  test("unknown members throw on call, naming the call and the config to add", async () => {
    const { db } = setup();
    const client = db.client as unknown as Record<string, Record<string, () => unknown>>;
    await expect(async () => client.orders?.list?.()).rejects.toThrow(UninstrumentedCallError);
    expect(() => client.orders?.list?.()).toThrowErrorMatchingInlineSnapshot(
      `[UninstrumentedCallError: db.orders.list is not instrumented: the store fake for client "db" knows db.orders.get (read), db.users.byId (read), db.orders.save (commit), db.transaction (transaction). Add "orders.list" to \`read\` (returns the row with the given key) or to \`commit\` (stores the given row). Other repository methods (queries, deletes) are not supported by the store fake.]`,
    );
    expect(() => client.payments?.get?.()).toThrow(
      'If "payments" is a collection, add `payments: { key: "id" }` to `collections` and its methods to `read` / `commit`.',
    );
    await db.client.transaction(async (tx) => {
      const t = tx as unknown as Record<string, Record<string, () => unknown>>;
      expect(() => t.orders?.delete?.()).toThrow(
        "db.orders.delete (on the `tx` passed by db.transaction) is not instrumented",
      );
    });
  });

  test("the fake survives await, JSON, String and identity checks", async () => {
    const { db } = setup();
    expect(await Promise.resolve(db.client)).toBe(db.client);
    expect(db.client.orders).toBe(db.client.orders);
    expect(JSON.stringify(db.client)).toBe('{"orders":{},"users":{}}');
    expect(String(db.client)).toBe("[object Object]");
    expect(typeof db.client.transaction).toBe("function");
  });

  test("bad configs and bad calls fail with the fix", async () => {
    const s = scheduler();
    expect(() =>
      store(s, {
        client: "db",
        collections: { orders: { key: "id" } },
        read: ["orders"] as never,
        commit: [],
      }),
    ).toThrow('store fake "db": read path "orders" must be "<collection>.<method>"');
    expect(() =>
      store(s, {
        client: "db",
        collections: { orders: { key: "id" } },
        read: ["users.get" as "orders.get"],
        commit: [],
      }),
    ).toThrow('store fake "db" has no collection "users" (collections: orders)');
    expect(() =>
      store(scheduler(), {
        client: "db",
        collections: { orders: { key: "id" } },
        read: ["orders.get"],
        commit: ["orders.get"],
      }),
    ).toThrow("db.orders.get is listed twice (a path is either a read or a commit)");

    const { db } = setup();
    await expect(db.client.orders.save({ status: "paid" })).rejects.toThrow(
      'db.orders.save: expected a orders row with a string or number "id" (the collection\'s key), got {"status":"paid"}',
    );
    await expect(db.client.orders.get({ where: { id: "o1" } } as never)).rejects.toThrow(
      "query objects are not supported",
    );
  });

  test("two instruments cannot share a gate label", () => {
    const s = scheduler();
    store(s, {
      client: "db",
      collections: { orders: { key: "id" } },
      read: ["orders.get"],
      commit: [],
    });
    expect(() =>
      store(s, {
        client: "db",
        collections: { orders: { key: "id" } },
        read: [],
        commit: ["orders.get"],
      }),
    ).toThrow('gate "db.orders.get" is already defined (sync) by store fake "db"');
  });
});
