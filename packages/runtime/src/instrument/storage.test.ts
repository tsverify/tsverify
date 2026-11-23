import { describe, expect, test } from "vitest";
import { type Schedule, scheduler } from "../scheduler";
import { effects } from "./effects";
import {
  StorageConditionError,
  type StorageFunctionInput,
  type StorageRoleInput,
  storage,
} from "./storage";

const fn = (
  symbol: string,
  args: StorageRoleInput[],
  extra: Partial<StorageFunctionInput> = {},
): StorageFunctionInput => ({ ref: { file: "src/orders/repo.ts", symbol }, args, ...extra });

/** The fixture app's repo: getOrder / saveOrder / setStatusIf / withTransaction. */
const REPO = {
  key: "id",
  read: [fn("getOrder", ["key"])],
  save: [fn("saveOrder", ["entity"])],
  update: [fn("setStatusIf", ["key", "from", "to"])],
  atomic: [fn("withTransaction", ["callback"])],
};

/** The symbols the tests bind. */
type Sym =
  | "getOrder"
  | "saveOrder"
  | "setStatusIf"
  | "withTransaction"
  | "findOrder"
  | "putOrder"
  | "patchOrder"
  | "countIf"
  | "refundIf"
  | "shipOrThrow";
// biome-ignore lint/suspicious/noExplicitAny: the tests call the fake as untyped app code would
type AppFn = (...args: any[]) => Promise<any>;

const paid = (status = "paid") => ({ id: "o1", status, chargeId: "ch_1", lines: [{ sku: "a" }] });

function setup(binding = REPO, missing?: (key: string) => unknown) {
  const s = scheduler();
  const fake = storage(s, {
    entity: "Order",
    state: "status",
    binding,
    seed: [paid()],
    ...(missing && { missing }),
  });
  return { s, fake, f: fake.functions as Record<Sym, AppFn> };
}

describe("instrument.storage", () => {
  test("read, save and update are sync gates storage.<symbol>; atomic is transparent", () => {
    const { s } = setup();
    expect(s.knownGates()).toEqual([
      "storage.getOrder",
      "storage.saveOrder",
      "storage.setStatusIf",
      "storage.withTransaction",
    ]);
  });

  test("copy on read and copy on write", async () => {
    const { fake, f } = setup();
    const row = await f.getOrder("o1");
    row.lines.push({ sku: "b" });
    row.status = "mutated";
    expect(fake.read("Order", "o1")).toEqual(paid());

    const order = { id: "o2", status: "pending" };
    await f.saveOrder(order);
    order.status = "mutated";
    expect(fake.read("Order", "o2")).toEqual({ id: "o2", status: "pending" });
    expect(fake.rows("Order").map((r) => r.id)).toEqual(["o1", "o2"]);
  });

  test("a missing key reads as undefined, or as the configured error", async () => {
    expect(await setup().f.getOrder("nope")).toBeUndefined();
    const { f } = setup(REPO, (key) => new Error(`order ${key} not found`));
    await expect(f.getOrder("nope")).rejects.toThrow("order nope not found");
  });

  test("roles are positional: _ is ignored, the key can come from an argument", async () => {
    const { fake, f } = setup({
      key: "id",
      read: [fn("findOrder", ["_", "key"])],
      save: [fn("putOrder", ["key", "entity"]), fn("patchOrder", ["key", "_", "patch"])],
      update: [],
      atomic: [],
    });
    expect(await f.findOrder({ tenant: "t" }, "o1")).toEqual(paid());
    await f.putOrder("o3", { status: "pending" });
    expect(fake.read("Order", "o3")).toEqual({ id: "o3", status: "pending" });
    await f.patchOrder("o1", "ignored", { note: "hi" });
    expect(fake.read("Order", "o1")).toEqual({ ...paid(), note: "hi" });
    await f.patchOrder("o4", null, { status: "pending" });
    expect(fake.read("Order", "o4")).toEqual({ id: "o4", status: "pending" });
  });

  describe("update: a conditional save", () => {
    test("sets the target state only from a from-state (one state or a list)", async () => {
      const { fake, f } = setup();
      expect(await f.setStatusIf("o1", ["pending"], "refunded")).toBe(false);
      expect(fake.read("Order", "o1")?.status).toBe("paid");
      expect(await f.setStatusIf("o1", "paid", "refunded")).toBe(true);
      expect(fake.read("Order", "o1")).toEqual(paid("refunded"));
      expect(await f.setStatusIf("o1", ["paid"], "refunded")).toBe(false);
      expect(await f.setStatusIf("missing", ["paid"], "refunded")).toBe(false);
    });

    test("returns per `returns`, with fixed states and a patch", async () => {
      const { fake, f } = setup({
        key: "id",
        read: [],
        save: [],
        update: [
          fn("countIf", ["key", "from", "to"], { returns: "count" }),
          fn("refundIf", ["key", "patch"], { returns: "entity", from: ["paid"], to: "refunded" }),
          fn("shipOrThrow", ["key"], { returns: "throws", from: ["paid"], to: "shipped" }),
        ],
        atomic: [],
      });
      expect(await f.countIf("o1", ["pending"], "paid")).toBe(0);
      expect(await f.countIf("o1", ["paid"], "paid")).toBe(1);
      await expect(f.shipOrThrow("o1")).resolves.toBeUndefined();
      expect(fake.read("Order", "o1")?.status).toBe("shipped");
      await expect(f.shipOrThrow("o1")).rejects.toThrow(StorageConditionError);
      await expect(f.shipOrThrow("o1")).rejects.toThrow(
        'storage.shipOrThrow("o1"): expected status in [paid], the stored Order is status "shipped"',
      );
      expect(await f.refundIf("o1", { reason: "x" })).toBeUndefined();
      fake.seed({ Order: [paid()] });
      expect(await f.refundIf("o1", { reason: "x" })).toEqual({
        ...paid("refunded"),
        reason: "x",
      });
    });
  });

  describe("atomic: one indivisible step", () => {
    test("reads inside see staged writes; others see them only after the callback resolves", async () => {
      const { fake, f } = setup();
      const result = await f.withTransaction(async () => {
        const order = await f.getOrder("o1");
        await f.saveOrder({ ...order, status: "refunded" });
        expect((await f.getOrder("o1")).status).toBe("refunded");
        expect(fake.read("Order", "o1")?.status).toBe("paid");
        return "ok";
      });
      expect(result).toBe("ok");
      expect(fake.read("Order", "o1")?.status).toBe("refunded");
    });

    test("a throw drops every staged write and rethrows", async () => {
      const { fake, f } = setup();
      await expect(
        f.withTransaction(async () => {
          await f.setStatusIf("o1", ["paid"], "refunded");
          await f.saveOrder({ id: "o9", status: "pending" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(fake.rows("Order")).toEqual([paid()]);
    });

    test("one at a time, also outside workers; a nested call runs inside the outer one", async () => {
      const { fake, f } = setup();
      const events: string[] = [];
      const tx = (name: string) =>
        f.withTransaction(async () => {
          events.push(`${name} begin`);
          const o = await f.getOrder("o1");
          await new Promise((r) => setImmediate(r));
          await f.withTransaction(() => f.saveOrder({ ...o, status: `${o.status}+${name}` }));
          events.push(`${name} end`);
        });
      await Promise.all([tx("a"), tx("b")]);
      expect(events).toEqual(["a begin", "a end", "b begin", "b end"]);
      expect(fake.read("Order", "o1")?.status).toBe("paid+a+b");
    });
  });

  test("seeds come back on reset; seed() lasts one run; only the bound entity", () => {
    const { s, fake } = setup();
    fake.seed({ Order: [paid("refunded"), { id: "o2", status: "pending" }] });
    expect(fake.rows("Order")).toHaveLength(2);
    s.reset();
    expect(fake.rows("Order")).toEqual([paid()]);
    expect(() => fake.read("User" as "Order", "u1")).toThrow(
      'storage fake for Order has no entity "User" (it stores Order)',
    );
  });

  test("bad arguments fail naming the function and the role", async () => {
    const { f } = setup();
    await expect(f.getOrder({ id: "o1" })).rejects.toThrow(
      'storage.getOrder: argument 1 has the "key" role, but got {"id":"o1"} (a string or number)',
    );
    await expect(f.saveOrder({ status: "paid" })).rejects.toThrow(
      'storage.saveOrder: expected a Order with a string or number "id" (the key), got {"status":"paid"}',
    );
    await expect(f.setStatusIf("o1", 3, "paid")).rejects.toThrow(
      'storage.setStatusIf: argument 2 has the "from" role, but got 3 (a state or a list of states)',
    );
    await expect(f.withTransaction("nope")).rejects.toThrow(
      'storage.withTransaction: argument 1 has the "callback" role, but got "nope" (a function)',
    );
  });
});

describe("replayed race: two concurrent refunds", () => {
  const s = scheduler();
  const fake = storage(s, { entity: "Order", state: "status", binding: REPO });
  const stripe = effects(s, { client: "stripe", calls: ["refunds.create"] });
  const { getOrder, saveOrder, setStatusIf, withTransaction } = fake.functions as Record<
    Sym,
    AppFn
  >;
  const refund = () => stripe.client.refunds.create({ charge: "ch_1" });

  /** Plain read + save: the status check and the write are two steps. */
  async function refundPlain(id: string) {
    const order = await getOrder(id);
    if (order.status !== "paid") throw new Error(`cannot refund a ${order.status} order`);
    await saveOrder({ ...order, status: "refunded" });
    await refund();
  }

  /** Conditional save: the check and the write are one step. */
  async function refundUpdate(id: string) {
    const order = await getOrder(id);
    if (order.status !== "paid") throw new Error(`cannot refund a ${order.status} order`);
    if (!(await setStatusIf(id, ["paid"], "refunded"))) throw new Error("conflict");
    await refund();
  }

  /** Read + save inside the named atomic function. */
  async function refundAtomic(id: string) {
    await withTransaction(async () => {
      const order = await getOrder(id);
      if (order.status !== "paid") throw new Error(`cannot refund a ${order.status} order`);
      await saveOrder({ ...order, status: "refunded" });
    });
    await refund();
  }

  const readReadWriteWrite = (write: string): Schedule => [
    ["refund#1", "storage.getOrder"],
    ["refund#2", "storage.getOrder"],
    ["refund#1", write],
    ["refund#2", write],
    ["refund#1", "until-done"],
    ["refund#2", "until-done"],
  ];

  async function race(impl: (id: string) => Promise<void>, schedule: Schedule) {
    s.reset();
    fake.seed({ Order: [paid()] });
    s.spawn("refund#1", () => impl("o1"));
    s.spawn("refund#2", () => impl("o1"));
    const outcome = await s.tryPlay(schedule);
    await s.drain();
    return {
      followed: outcome.followed,
      divergence: outcome.followed ? undefined : outcome.divergence.details.kind,
      refunds: stripe.calls("refunds.create").length,
      status: fake.read("Order", "o1")?.status,
      outcomes: ["refund#1", "refund#2"].map((w) => s.outcome(w).status),
    };
  }

  test("read + save interleave: both read paid, both refund", async () => {
    expect(await race(refundPlain, readReadWriteWrite("storage.saveOrder"))).toEqual({
      followed: true,
      divergence: undefined,
      refunds: 2,
      status: "refunded",
      outcomes: ["done", "done"],
    });
  });

  test("update: the second conditional save finds refunded and refunds nothing", async () => {
    expect(await race(refundUpdate, readReadWriteWrite("storage.setStatusIf"))).toEqual({
      followed: true,
      divergence: undefined,
      refunds: 1,
      status: "refunded",
      outcomes: ["done", "failed"],
    });
  });

  test("atomic: the second worker waits for the first, so the interleaving is blocked", async () => {
    expect(await race(refundAtomic, readReadWriteWrite("storage.saveOrder"))).toEqual({
      followed: false,
      divergence: "blocked",
      refunds: 1,
      status: "refunded",
      outcomes: ["done", "failed"],
    });
  });

  test("deterministic: 50/50 identical double refunds through read + save", async () => {
    const first = JSON.stringify(await race(refundPlain, readReadWriteWrite("storage.saveOrder")));
    let identical = 0;
    for (let i = 0; i < 50; i++) {
      const run = await race(refundPlain, readReadWriteWrite("storage.saveOrder"));
      if (JSON.stringify(run) === first) identical++;
    }
    expect(identical).toBe(50);
  });
});
