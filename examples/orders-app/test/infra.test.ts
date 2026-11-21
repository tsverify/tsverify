import { beforeEach, describe, expect, it } from "vitest";
import { requireOwner, requireRole } from "../src/auth/guards";
import { createDatabase } from "../src/db";
import { ForbiddenError, NotFoundError } from "../src/errors";
import { email, emailFake } from "../src/notify/email";
import type { Order } from "../src/orders/order";
import { stripe, stripeFake } from "../src/payments/stripe";
import { admin, alice, bob, resetApp } from "./seed";

const draft: Order = { id: "o1", ownerId: "alice", email: "a@example.com", status: "draft" };

describe("db", () => {
  it("returns and stores copies", async () => {
    const db = createDatabase();
    const order = { ...draft };
    await db.orders.save(order);
    order.status = "paid";
    const read = await db.orders.get("o1");
    expect(read.status).toBe("draft");
    read.status = "shipped";
    expect((await db.orders.get("o1")).status).toBe("draft");
  });

  it("throws NotFoundError for a missing order", async () => {
    await expect(createDatabase().orders.get("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("commits transaction writes when the callback resolves", async () => {
    const db = createDatabase();
    await db.orders.save(draft);
    const result = await db.transaction(async (tx) => {
      const order = await tx.orders.get("o1");
      order.status = "pending_payment";
      await tx.orders.save(order);
      expect((await tx.orders.get("o1")).status).toBe("pending_payment");
      expect((await db.orders.get("o1")).status).toBe("draft");
      return "done";
    });
    expect(result).toBe("done");
    expect((await db.orders.get("o1")).status).toBe("pending_payment");
  });

  it("discards transaction writes when the callback throws", async () => {
    const db = createDatabase();
    await db.orders.save(draft);
    const failing = db.transaction(async (tx) => {
      await tx.orders.save({ ...draft, status: "paid" });
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect((await db.orders.get("o1")).status).toBe("draft");
  });

  it("serializes transactions", async () => {
    const db = createDatabase();
    const log: string[] = [];
    const run = (name: string) =>
      db.transaction(async () => {
        log.push(`${name}:start`);
        await Promise.resolve();
        await Promise.resolve();
        log.push(`${name}:end`);
      });
    await Promise.all([run("a"), run("b"), run("c")]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("releases the mutex after a failed transaction", async () => {
    const db = createDatabase();
    await expect(db.transaction(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(db.transaction(async () => 1)).resolves.toBe(1);
  });
});

describe("guards", () => {
  it("requireOwner accepts the owner and rejects anyone else", () => {
    expect(() => requireOwner(alice, draft)).not.toThrow();
    expect(() => requireOwner(bob, draft)).toThrow(ForbiddenError);
  });

  it("requireRole accepts an admin and rejects a customer", () => {
    expect(() => requireRole(admin, "admin")).not.toThrow();
    expect(() => requireRole(alice, "admin")).toThrow(ForbiddenError);
  });
});

describe("fake clients", () => {
  beforeEach(resetApp);

  it("stripe records refunds", async () => {
    const refund = await stripe.refunds.create({ charge: "ch_1" });
    expect(refund).toEqual({ id: "re_1", charge: "ch_1" });
    expect(stripeFake.refunds()).toEqual([refund]);
    stripeFake.reset();
    expect(stripeFake.refunds()).toEqual([]);
  });

  it("email records sent messages", async () => {
    await email.send({ to: "a@example.com", template: "receipt" });
    expect(emailFake.sent()).toEqual([{ to: "a@example.com", template: "receipt" }]);
  });
});
