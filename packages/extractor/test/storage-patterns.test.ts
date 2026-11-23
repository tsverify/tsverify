/**
 * The `functions` adapter (`bindings.storage` naming the app's own functions), one pattern per
 * test, each on a small temp project: how reads, saves, conditional saves and atomic functions
 * are recognised by symbol, and how a conditional save's result decides which effects belong to
 * the transition.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Bindings,
  StorageBinding,
  StorageFunction,
  StorageKind,
  StorageRole,
} from "@tsverify/ir";
import { defaultStorageArgs, parseSymbolRef } from "@tsverify/ir";
import { afterAll, describe, expect, it } from "vitest";
import { type ExtractResult, extractAll } from "../src/index";
import { orderSpec, type TransitionSpec, transitionOf, withoutBindingWarnings } from "./helpers";
import { installTypeScript } from "./typescript";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2022",
    lib: ["es2022"],
    module: "esnext",
    moduleResolution: "bundler",
    types: [],
  },
  include: ["src"],
});

/** The app's storage layer: a Map, and every kind of function the binding can name. */
const REPO = `
export type Status = "draft" | "pending_payment" | "paid" | "shipped" | "refunded" | "cancelled";
export interface Order { id: string; status: Status; chargeId: string }
const orders = new Map<string, Order>();
export async function getOrder(id: string): Promise<Order | undefined> {
  const o = orders.get(id);
  return o && { ...o };
}
export async function findOrder(_tenant: string, id: string): Promise<Order | undefined> {
  return getOrder(id);
}
export async function saveOrder(order: Order): Promise<void> {
  orders.set(order.id, { ...order });
}
export async function patchOrder(id: string, patch: Partial<Order>): Promise<void> {
  const o = orders.get(id);
  if (o) orders.set(id, { ...o, ...patch });
}
export async function setStatusIf(id: string, from: Status | readonly Status[], to: Status): Promise<boolean> {
  const o = orders.get(id);
  const allowed: readonly Status[] = Array.isArray(from) ? from : [from as Status];
  if (!o || !allowed.includes(o.status)) return false;
  orders.set(id, { ...o, status: to });
  return true;
}
export async function markShipped(id: string): Promise<number> {
  return (await setStatusIf(id, "paid", "shipped")) ? 1 : 0;
}
export async function refundIf(id: string, from: Status): Promise<Order | undefined> {
  return (await setStatusIf(id, from, "refunded")) ? getOrder(id) : undefined;
}
export async function cancelOrThrow(id: string): Promise<void> {
  if (!(await setStatusIf(id, "pending_payment", "cancelled"))) throw new Error("changed");
}
export const repo = { get: getOrder, save: saveOrder };
/** One object of named arguments: no argument of its own carries the key. */
export async function getByArgs(args: { id: string; tenant: string }): Promise<Order | undefined> {
  return getOrder(args.id);
}
/** A storage interface the app injects (\`deps.orders.get(id)\`). */
export interface OrderStore { get(id: string): Promise<Order | undefined> }
`;
const DB = `
let tail: Promise<unknown> = Promise.resolve();
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.catch(() => undefined);
  return run;
}
`;
const INDEX = `
export { getOrder as loadOrder, saveOrder, setStatusIf as updateIf } from "./repo";
export * as store from "./repo";
`;
const CLIENTS = `
export const stripe = { refunds: { async create(_p: { charge: string }) { return { id: "re_1" }; } } };
export const email = { async send(_to: string, _what: string) {} };
export const legacy = { async patch(_id: string, _p: Partial<import("./repo").Order>) {} };
// A query builder in the style of Drizzle: no entity type, the column's states plus SQL.
type SQL = { sql: string };
export const qb = {
  update(_table: "orders") {
    return {
      set(_values: { status?: import("./repo").Status | SQL; note?: string | SQL }) {
        return { async where(_cond: unknown): Promise<number> { return 1; } };
      },
    };
  },
};
export const http = { json(_body: unknown) {} };
// An event whose type has exactly the entity's states: not an update, so not a write.
// An ORM call the binding doesn't name, in Prisma's shape.
export const orm = {
  order: {
    async update(_a: { where: { id: string }; data: { status?: import("./repo").Status } }) {},
  },
};
export const bus = { async publish(_e: { id: string; status: import("./repo").Status }) {} };
`;

type FnSpec = string | ({ fn: string; args?: StorageRole[] } & Partial<StorageFunction>);

function fn(kind: StorageKind, spec: FnSpec): StorageFunction {
  const s = typeof spec === "string" ? { fn: spec } : spec;
  const fixed = { ...(s.from ? { from: s.from } : {}), ...(s.to ? { to: s.to } : {}) };
  const ref = parseSymbolRef(s.fn);
  if (!ref) throw new Error(`not path#symbol: ${s.fn}`);
  return {
    ref,
    args: s.args ?? defaultStorageArgs(kind, fixed),
    ...(s.returns ? { returns: s.returns } : {}),
    ...fixed,
  };
}

function storageOf(b: Partial<Record<StorageKind, FnSpec[]>>): StorageBinding {
  return {
    key: "id",
    read: (b.read ?? []).map((s) => fn("read", s)),
    save: (b.save ?? []).map((s) => fn("save", s)),
    update: (b.update ?? []).map((s) => fn("update", s)),
    atomic: (b.atomic ?? []).map((s) => fn("atomic", s)),
  };
}

const DEFAULT_STORAGE = storageOf({
  read: ["src/repo.ts#getOrder", { fn: "src/repo.ts#findOrder", args: ["_", "key"] }],
  save: ["src/repo.ts#saveOrder", { fn: "src/repo.ts#patchOrder", args: ["key", "patch"] }],
  update: [
    "src/repo.ts#setStatusIf",
    { fn: "src/repo.ts#markShipped", from: ["paid"], to: "shipped", returns: "count" },
    { fn: "src/repo.ts#refundIf", args: ["key", "from"], to: "refunded", returns: "entity" },
    {
      fn: "src/repo.ts#cancelOrThrow",
      from: ["pending_payment"],
      to: "cancelled",
      returns: "throws",
    },
  ],
  atomic: ["src/db.ts#withTransaction"],
});

function bindings(storage = DEFAULT_STORAGE): Bindings {
  return {
    storage,
    clients: {
      email: { module: "src/clients.ts", export: "email" },
      legacy: { module: "src/clients.ts", export: "legacy" },
      stripe: { module: "src/clients.ts", export: "stripe" },
    },
    guards: {},
    effects: { "email.receipt": "email.send", "stripe.refund": "stripe.refunds.create" },
  };
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Extracts `impl` (the file `src/impl.ts`) next to the storage layer. */
function extract(
  impl: string,
  transitions: TransitionSpec[],
  storage?: StorageBinding,
  bindingWarnings = false,
): ExtractResult {
  const root = mkdtempSync(join(tmpdir(), "tsverify-storage-"));
  roots.push(root);
  const files: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/repo.ts": REPO,
    "src/db.ts": DB,
    "src/index.ts": INDEX,
    "src/clients.ts": CLIENTS,
    "src/impl.ts": impl,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const spec = orderSpec(transitions, bindings(storage));
  const { results } = extractAll([spec], { projectRoot: root, typescript: installTypeScript() });
  const result = results[0] as ExtractResult;
  // Each test calls a few of the many bound functions: "bound but never called" is tested apart.
  return bindingWarnings ? result : withoutBindingWarnings(result);
}

const IMPORTS = `
import { getOrder, findOrder, saveOrder, patchOrder, setStatusIf, markShipped, refundIf, cancelOrThrow, repo } from "./repo";
import { loadOrder, updateIf, store } from "./index";
import { withTransaction } from "./db";
import { stripe, email, legacy, qb, http, bus, orm } from "./clients";
`;

function t(name: string, to: string, extra: Partial<TransitionSpec> = {}): TransitionSpec {
  return { name, impl: `src/impl.ts#${name}`, to, ...extra };
}

describe("read + save (entity)", () => {
  const result = extract(
    `${IMPORTS}
export async function ship(id: string) {
  await withTransaction(async () => {
    const order = await getOrder(id);
    if (order?.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await saveOrder(order);
  });
}
export async function shipOutside(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "paid") throw new Error("not paid");
  await withTransaction(async () => {
    order.status = "shipped";
    await saveOrder(order);
  });
}
export async function shipReadInside(id: string) {
  let order: Awaited<ReturnType<typeof getOrder>>;
  await withTransaction(async () => {
    const o = await getOrder(id);
    if (o?.status !== "paid") throw new Error("not paid");
    o.status = "shipped";
    order = o;
  });
  await saveOrder(order!);
}
export async function shipSpread(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "paid") throw new Error("not paid");
  await saveOrder({ ...order, status: "shipped" });
}
`,
    [
      t("ship", "shipped"),
      t("shipOutside", "shipped"),
      t("shipReadInside", "shipped"),
      t("shipSpread", "shipped"),
    ],
  );

  it("reports nothing but the read-inside write it cannot follow", () => {
    expect(result.findings.map((f) => f.id)).toEqual([
      "unanalyzable:Fixture orders:storage:shipReadInside",
    ]);
  });

  it("a read and a save inside the atomic callback: atomic, as declared", () => {
    const s = transitionOf(result, "ship");
    expect(s.atomic).toBe(true);
    expect(s.from).toEqual(["paid"]);
    expect(s.sites).toMatchObject({
      persistence: "functions",
      read: { client: "storage", path: "getOrder", gate: "storage.getOrder", occurrence: 0 },
      commit: { client: "storage", path: "saveOrder", gate: "storage.saveOrder" },
      atomic: { kind: "declared", gate: "storage.withTransaction", at: { line: 8 } },
      storage: { client: "storage", collection: "Order", key: "id" },
      invocation: { entityId: { param: 0, path: [] } },
    });
  });

  it("a read outside and a save inside: not atomic", () => {
    const s = transitionOf(result, "shipOutside");
    expect(s.atomic).toBe(false);
    expect(s.sites?.atomic).toBeUndefined();
    expect(s.sites?.commit?.gate).toBe("storage.saveOrder");
  });

  it("a spread passed to the save is the write; its call is the commit", () => {
    const s = transitionOf(result, "shipSpread");
    expect(s.atomic).toBe(false);
    expect(s.from).toEqual(["paid"]);
    expect(s.sites?.read?.gate).toBe("storage.getOrder");
    expect(s.sites?.commit).toMatchObject({ gate: "storage.saveOrder", at: { line: 36 } });
  });
});

describe("by symbol: imports, re-exports, aliases, namespaces, methods", () => {
  const result = extract(
    `${IMPORTS}
export async function viaAlias(id: string) {
  await withTransaction(async () => {
    const order = await loadOrder(id);
    if (order?.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await store.saveOrder(order);
  });
}
export async function viaMethod(id: string) {
  await withTransaction(async () => {
    const order = await repo.get(id);
    if (order?.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await repo.save(order);
  });
}
export async function viaRenamedUpdate(id: string) {
  if (!(await updateIf(id, "paid", "shipped"))) throw new Error("changed");
}
async function getOrderLookalike(id: string): Promise<import("./repo").Order> {
  return { id, status: "paid", chargeId: "" };
}
export async function lookalike(id: string) {
  const order = await getOrderLookalike(id);
  if (order.status !== "paid") return;
  order.status = "shipped";
}
`,
    [
      t("viaAlias", "shipped"),
      t("viaMethod", "shipped"),
      t("viaRenamedUpdate", "shipped"),
      t("lookalike", "shipped", { atomic: false }),
    ],
    storageOf({
      read: ["src/repo.ts#getOrder", "src/repo.ts#repo.get"],
      save: ["src/repo.ts#saveOrder", "src/repo.ts#repo.save"],
      update: ["src/repo.ts#setStatusIf"],
      atomic: ["src/db.ts#withTransaction"],
    }),
  );

  it("a renamed re-export and a namespace import are the bound functions", () => {
    const s = transitionOf(result, "viaAlias");
    expect(s.atomic).toBe(true);
    expect(s.sites?.read?.gate).toBe("storage.getOrder");
    expect(s.sites?.commit?.gate).toBe("storage.saveOrder");
  });

  it("a bound method of an exported object (`repo.get`) is recognized", () => {
    const s = transitionOf(result, "viaMethod");
    expect(s.sites?.read?.gate).toBe("storage.repo.get");
    expect(s.sites?.commit?.gate).toBe("storage.repo.save");
    expect(s.atomic).toBe(true);
  });

  it("a conditional save under another name is still the update", () => {
    const s = transitionOf(result, "viaRenamedUpdate");
    expect(s.sites?.commit?.gate).toBe("storage.setStatusIf");
    expect(s.sites?.atomic?.kind).toBe("conditional-update");
  });

  it("a function named like a storage function is not one", () => {
    const s = transitionOf(result, "lookalike");
    expect(s.sites?.read).toBeUndefined();
    expect(result.findings.map((f) => f.id)).toContain(
      "unanalyzable:Fixture orders:storage:lookalike",
    );
  });
});

describe("save [key, patch]", () => {
  const result = extract(
    `${IMPORTS}
export async function cancel(id: string) {
  await withTransaction(async () => {
    const order = await getOrder(id);
    if (order?.status !== "pending_payment") throw new Error("not pending");
    await patchOrder(id, { status: "cancelled" });
  });
}
export async function cancelBlind(id: string) {
  await patchOrder(id, { status: "cancelled" });
}
export async function cancelLegacy(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  await legacy.patch(id, { status: "cancelled" });
}
`,
    [
      t("cancel", "cancelled", { from: ["pending_payment"] }),
      t("cancelBlind", "cancelled", { from: ["pending_payment"] }),
      t("cancelLegacy", "cancelled", { from: ["pending_payment"] }),
    ],
  );

  it("the patch is the write, its from-state the narrowed state at the call", () => {
    const s = transitionOf(result, "cancel");
    expect(s.from).toEqual(["pending_payment"]);
    expect(s.atomic).toBe(true);
    expect(s.sites).toMatchObject({
      write: { line: 11 },
      read: { gate: "storage.getOrder" },
      commit: { gate: "storage.patchOrder" },
      atomic: { kind: "declared", gate: "storage.withTransaction" },
      invocation: { entityId: { param: 0, path: [] } },
    });
  });

  it("a patch with no read before it writes from every state", () => {
    const s = transitionOf(result, "cancelBlind");
    expect(s.sites?.fromState).toMatchObject({ unconstrained: true });
    expect(s.from).toEqual([
      "draft",
      "pending_payment",
      "paid",
      "shipped",
      "refunded",
      "cancelled",
    ]);
  });

  it("a patch passed to an unbound data layer is unanalyzable, naming the storage kinds", () => {
    const f = result.findings.find(
      (x) => x.id === "unanalyzable:Fixture orders:storage:cancelLegacy",
    );
    expect(f?.message).toContain("`legacy.patch`, which is not a `bindings.storage.save` function");
    expect(f?.hint).toContain("`bindings.storage` (`read`, `save`, `update` or `atomic`)");
    // No verdict on what it can't read: atomic as specified, with the reason.
    const s = transitionOf(result, "cancelLegacy");
    expect(s.atomic).toBe(true);
    expect(s.sites?.atomicUnknown).toContain("`legacy.patch`");
  });
});

describe("patches held in a variable", () => {
  const result = extract(
    `${IMPORTS}
import type { Order, Status } from "./repo";
export async function heldConst(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  const patch: Partial<Order> = { status: "cancelled" };
  await patchOrder(id, patch);
}
export async function heldValue(id: string, next: Status) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  const patch: Partial<Order> = { status: next };
  await patchOrder(id, patch);
}
export async function heldLater(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  const patch: Partial<Order> = {};
  patch.status = "cancelled";
  await patchOrder(id, patch);
}
export async function heldLet(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  let patch: Partial<Order> = { status: "cancelled" };
  await patchOrder(id, patch);
}
export async function heldUnbound(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  const patch: Partial<Order> = { status: "cancelled" };
  await legacy.patch(id, patch);
}
export async function builderHeld(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  const patch: { status?: Status; note?: string } = { status: "cancelled", note: "x" };
  patch.note = "y";
  await qb.update("orders").set(patch).where(id);
}
export async function builderInline(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  await qb.update("orders").set({ status: "cancelled" }).where(id);
}
export async function builderNoRead(id: string) {
  await qb.update("orders").set({ status: "cancelled" }).where(id);
  const patch: { status?: Status } = { status: "cancelled" };
  await qb.update("orders").set(patch).where(id);
}
export async function reply(id: string) {
  const order = await getOrder(id);
  const body = { status: "ok", id: order?.id };
  http.json(body);
  http.json({ status: "ok" });
}
export async function ormUpdate(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "paid") throw new Error("not paid");
  await orm.order.update({ where: { id }, data: { status: "shipped" } });
}
export async function announce(id: string) {
  await bus.publish({ id, status: "cancelled" });
}
`,
    [
      t("heldConst", "cancelled", { from: ["pending_payment"] }),
      t("heldValue", "cancelled", { from: ["pending_payment"] }),
      t("heldLater", "cancelled", { from: ["pending_payment"] }),
      t("heldLet", "cancelled", { from: ["pending_payment"] }),
      t("heldUnbound", "cancelled", { from: ["pending_payment"] }),
      t("builderHeld", "cancelled", { from: ["pending_payment"] }),
      t("builderInline", "cancelled", { from: ["pending_payment"] }),
      t("builderNoRead", "cancelled", { from: ["pending_payment"] }),
      t("ormUpdate", "shipped", { from: ["paid"] }),
    ],
  );
  const finding = (id: string) => result.findings.find((f) => f.id === id);

  it("reports every write it can't read, and nothing for objects that aren't the entity's", () => {
    expect(result.findings.map((f) => f.id)).toEqual([
      "unanalyzable:Fixture orders:from-state:builderNoRead",
      "unanalyzable:Fixture orders:from-state:builderNoRead~2",
      "unanalyzable:Fixture orders:storage:builderHeld",
      "unanalyzable:Fixture orders:storage:builderInline",
      "unanalyzable:Fixture orders:storage:builderNoRead",
      "unanalyzable:Fixture orders:storage:builderNoRead~2",
      "unanalyzable:Fixture orders:storage:heldUnbound",
      "unanalyzable:Fixture orders:storage:ormUpdate",
      "unanalyzable:Fixture orders:write-shape:heldLater",
      "unanalyzable:Fixture orders:write-shape:heldLet",
      "unanalyzable:Fixture orders:write-value:heldValue",
    ]);
  });

  it("a const patch passed to one bound save is read like a patch written into the call", () => {
    const s = transitionOf(result, "heldConst");
    expect(s.from).toEqual(["pending_payment"]);
    expect(s.sites).toMatchObject({
      write: { line: 11 },
      read: { gate: "storage.getOrder" },
      commit: { gate: "storage.patchOrder", at: { line: 12 } },
      invocation: { entityId: { param: 0, path: [] } },
    });
  });

  it("a held patch it can't read is not extracted, and says why", () => {
    expect(finding("unanalyzable:Fixture orders:write-value:heldValue")?.message).toBe(
      "Order.status is assigned a value that is not a single literal (next); the write is not extracted",
    );
    expect(finding("unanalyzable:Fixture orders:write-shape:heldLater")).toMatchObject({
      message:
        "Order.status is set on `patch`, an object later passed to `patchOrder`, after the object is built (`patch.status = …`); the write is not extracted",
      codeAt: { line: 24 },
    });
    expect(finding("unanalyzable:Fixture orders:write-shape:heldLet")?.message).toBe(
      "Order.status is set in `patch`, an object later passed to `patchOrder`, but `patch` is not a `const`; the write is not extracted",
    );
    expect(finding("unanalyzable:Fixture orders:write-shape:heldLet")?.hint).toContain(
      "Restructuring unanalyzable code",
    );
    // Not extracted: the code model has each unconfirmed transition as specified, without sites
    // (like a transition without `impl`), so it doesn't lose behavior the code may have.
    for (const n of ["heldValue", "heldLater", "heldLet"]) {
      const copies = result.model?.transitions.filter((x) => x.name === n) ?? [];
      expect(copies.every((c) => c.sites === undefined)).toBe(true);
    }
    expect(result.model?.transitions.find((x) => x.name === "heldLater")).toMatchObject({
      to: "cancelled",
      impl: { symbol: "heldLater" },
    });
  });

  it("records the unread writes each impl reaches, for conformance", () => {
    expect(result.model?.unreadWrites).toEqual({
      heldLater: [
        {
          at: expect.objectContaining({ line: 24 }),
          function: "heldLater",
          reason: "`patch.status` is set after the object is built",
          value: "cancelled",
          finding: "unanalyzable:Fixture orders:write-shape:heldLater",
        },
      ],
      heldLet: [
        {
          at: expect.objectContaining({ line: 30 }),
          function: "heldLet",
          reason: "status is set in `patch`, but `patch` is not a `const`",
          value: "cancelled",
          finding: "unanalyzable:Fixture orders:write-shape:heldLet",
        },
      ],
      heldValue: [
        {
          at: expect.objectContaining({ line: 17 }),
          function: "heldValue",
          reason: "the value `next` is not a single literal",
          finding: "unanalyzable:Fixture orders:write-value:heldValue",
        },
      ],
    });
  });

  it("a held patch passed to an unbound function is like one written into it", () => {
    expect(finding("unanalyzable:Fixture orders:storage:heldUnbound")?.message).toContain(
      "`legacy.patch`, which is not a `bindings.storage.save` function",
    );
    const s = transitionOf(result, "heldUnbound");
    expect(s.from).toEqual(["pending_payment"]);
    expect(s.sites?.atomicUnknown).toBeDefined();
  });

  it("an update with no read of one entity before it (bulk) is the entity's too: reported, never silent", () => {
    const noRead = transitionOf(result, "builderNoRead");
    expect(noRead.from).toBe("*");
    expect(finding("unanalyzable:Fixture orders:storage:builderNoRead")?.message).toContain(
      '`qb.update("orders").set`, which is not a `bindings.storage.save` function',
    );
    expect(finding("unanalyzable:Fixture orders:from-state:builderNoRead")?.hint).toContain(
      "Nothing reads one Order before this update",
    );
    // A `status` object passed to a call that is not an update is not a write.
    expect(result.findings.some((f) => f.message.includes("bus.publish"))).toBe(false);
    expect(result.model?.transitions.some((x) => x.sites?.function.name === "announce")).toBe(
      false,
    );
  });

  it("an ORM update's `data` is a patch passed to a function the binding doesn't name", () => {
    expect(transitionOf(result, "ormUpdate").from).toEqual(["paid"]);
    expect(finding("unanalyzable:Fixture orders:storage:ormUpdate")?.message).toContain(
      "`orm.order.update`, which is not a `bindings.storage.save` function",
    );
  });

  it("a query builder's patch is the entity's when its states are exactly the entity's, after a read", () => {
    expect(transitionOf(result, "builderHeld").from).toEqual(["pending_payment"]);
    expect(transitionOf(result, "builderInline").from).toEqual(["pending_payment"]);
    expect(finding("unanalyzable:Fixture orders:storage:builderInline")?.message).toContain(
      '`qb.update("orders").set`',
    );
  });
});

describe("a read whose type doesn't name the entity", () => {
  // The row type of a query builder or a schema library (\`z.infer<…>\`, \`$inferSelect\`) is
  // an anonymous object type: its name is lost, but it is what a bound read returned.
  const result = extract(
    `${IMPORTS}
import type { Status } from "./repo";
export async function getRow(id: string): Promise<{ id: string; status: Status } | undefined> {
  return getOrder(id);
}
export async function cancel(id: string) {
  const row = await getRow(id);
  if (!row) throw new Error("missing");
  if (row.status !== "pending_payment") throw new Error("not pending");
  await qb.update("orders").set({ status: "cancelled", note: "x" }).where(id);
}
export async function cancelUnread(id: string) {
  const other = await Promise.resolve({ status: "x" });
  await legacy.patch(id, { status: "cancelled" });
  return other;
}
`,
    [
      t("cancel", "cancelled", { from: ["pending_payment"] }),
      t("cancelUnread", "cancelled", { from: ["pending_payment"] }),
    ],
    storageOf({
      read: ["src/impl.ts#getRow"],
      save: [{ fn: "src/repo.ts#patchOrder", args: ["key", "patch"] }],
    }),
  );

  it("the patch's from-state is read from the bound read before it", () => {
    expect(transitionOf(result, "cancel").from).toEqual(["pending_payment"]);
    expect(result.findings.map((f) => f.id)).not.toContain(
      "unanalyzable:Fixture orders:from-state:cancel",
    );
  });

  it("with no read before the write, the hint says to read it, not to retype the field", () => {
    const f = result.findings.find(
      (x) => x.id === "unanalyzable:Fixture orders:from-state:cancelUnread",
    );
    expect(f?.message).toBe(
      "cancelUnread: the from-state of this write is unknown: no read of the Order precedes the call",
    );
    expect(f?.hint).toBe(
      "Read the Order with a `bindings.storage.read` function into a `const` before the write, in the function that writes it (`const x = await getRow(…)`), and check `x.status` there.",
    );
  });
});

describe("update (conditional save)", () => {
  const result = extract(
    `${IMPORTS}
const FROM = ["paid"] as const;
export async function refund(id: string) {
  const order = await getOrder(id);
  if (!order || order.status !== "paid") throw new Error("not paid");
  if (!(await setStatusIf(id, ["paid"], "refunded"))) {
    await email.send("ops", "refund raced");
    throw new Error("changed");
  }
  await stripe.refunds.create({ charge: order.chargeId });
}
export async function refundTuple(id: string) {
  const ok = await setStatusIf(id, FROM, "refunded");
  if (!ok) return;
  await stripe.refunds.create({ charge: "ch" });
}
export async function refundWide(id: string) {
  if (!(await setStatusIf(id, ["paid", "shipped"], "refunded"))) return;
}
export async function refundEarly(id: string) {
  const ok = await setStatusIf(id, "paid", "refunded");
  await stripe.refunds.create({ charge: "ch" });
  if (!ok) throw new Error("changed");
}
export async function refundBefore(id: string) {
  await stripe.refunds.create({ charge: "ch" });
  if (!(await setStatusIf(id, "paid", "refunded"))) throw new Error("changed");
}
export async function ship(id: string) {
  if ((await markShipped(id)) === 0) return;
  await email.send("customer", "shipped");
}
export async function refundEntity(id: string) {
  const updated = await refundIf(id, "paid");
  if (updated === undefined) return;
  await stripe.refunds.create({ charge: updated.chargeId });
}
export async function cancel(id: string) {
  await cancelOrThrow(id);
  await email.send("customer", "cancelled");
}
async function doRefund(id: string) {
  return setStatusIf(id, "paid", "refunded");
}
export async function refundViaHelper(id: string) {
  if (!(await doRefund(id))) throw new Error("changed");
  await stripe.refunds.create({ charge: "ch" });
}
async function doRefundQuietly(id: string) {
  if (!(await setStatusIf(id, "paid", "refunded"))) return;
}
export async function refundViaQuietHelper(id: string) {
  await doRefundQuietly(id);
  await stripe.refunds.create({ charge: "ch" });
}
`,
    [
      t("refund", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
      t("refundTuple", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
      t("refundWide", "refunded"),
      t("refundEarly", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
      t("refundBefore", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
      t("ship", "shipped", { effects: [{ name: "email.receipt", multiplicity: "exactly-once" }] }),
      t("refundEntity", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
      t("cancel", "cancelled", {
        from: ["pending_payment"],
        effects: [{ name: "email.receipt", multiplicity: "exactly-once" }],
      }),
      t("refundViaHelper", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
      t("refundViaQuietHelper", "refunded", {
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
      }),
    ],
  );

  it("reports no findings", () => {
    expect(result.findings).toEqual([]);
  });

  it("the call is the write and the commit, atomic on its own; the read is the one before it", () => {
    const s = transitionOf(result, "refund");
    expect(s.atomic).toBe(true);
    expect(s.from).toEqual(["paid"]);
    expect(s.sites).toMatchObject({
      write: { line: 11, column: 15 },
      read: { gate: "storage.getOrder", at: { line: 9 } },
      commit: { gate: "storage.setStatusIf", at: { line: 11 } },
      atomic: { kind: "conditional-update", gate: "storage.setStatusIf", at: { line: 11 } },
    });
  });

  it("an effect in the branch that runs when the save failed is not the transition's", () => {
    const s = transitionOf(result, "refund");
    expect(s.sites?.effects.map((e) => e.effect)).toEqual(["stripe.refund"]);
  });

  it("from-states come from the from argument: a literal, an array, a tuple constant", () => {
    expect(transitionOf(result, "refundTuple").from).toEqual(["paid"]);
    expect(transitionOf(result, "refundWide").from).toEqual(["paid", "shipped"]);
    expect(transitionOf(result, "refundEarly").from).toEqual(["paid"]);
  });

  it("an effect before the result is checked, or before the save, escapes the atomic step", () => {
    for (const name of ["refundEarly", "refundBefore", "refundViaQuietHelper"]) {
      const s = transitionOf(result, name);
      expect({ name, atomic: s.atomic, scope: s.sites?.atomic }).toEqual({
        name,
        atomic: false,
        scope: undefined,
      });
      expect(s.sites?.atomicNote?.message).toBe(
        "stripe.refunds.create can run although storage.setStatusIf found status changed: the call is not behind a check of the save's result",
      );
      expect(s.sites?.effects.map((e) => e.effect)).toEqual(["stripe.refund"]);
    }
  });

  it("an unconditional update (`from` every state) never fails, so no effect escapes it", () => {
    const all = ["draft", "pending_payment", "paid", "shipped", "refunded", "cancelled"];
    const blind = extract(
      `${IMPORTS}
export async function shipBlind(id: string) {
  await email.send(id, "shipping");
  await markShipped(id);
}
`,
      [t("shipBlind", "shipped", { from: ["paid"] })],
      storageOf({
        read: ["src/repo.ts#getOrder"],
        update: [{ fn: "src/repo.ts#markShipped", from: all, to: "shipped", returns: "throws" }],
      }),
    );
    const s = transitionOf(blind, "shipBlind");
    expect(s.atomic).toBe(true);
    expect(s.sites?.atomicNote).toBeUndefined();
    expect(s.sites?.effects.map((e) => e.gate)).toEqual(["email.send"]);
    expect(s.from).toEqual(all);
  });

  it("an effect that follows another conditional save that went through is that save's", () => {
    const all = ["draft", "pending_payment", "paid", "shipped", "refunded", "cancelled"];
    const result = extract(
      `${IMPORTS}
async function tryShip(id: string): Promise<boolean> {
  if (!(await setStatusIf(id, "paid", "shipped"))) return false;
  await email.send(id, "shipped");
  return true;
}
/** Ships when it can, else cancels: the email is the shipment's, not the cancellation's. */
export async function shipOrCancel(id: string) {
  if (await tryShip(id)) return;
  if (!(await setStatusIf(id, "paid", "cancelled"))) throw new Error("changed");
}
/** After a save that can't fail, an effect is that save's too. */
export async function shipThenCancel(id: string) {
  await markShipped(id);
  await email.send(id, "shipped");
  if (!(await setStatusIf(id, "shipped", "cancelled"))) throw new Error("changed");
}
/** An effect before both saves still runs although the second one finds the state changed. */
export async function emailFirst(id: string) {
  await email.send(id, "working on it");
  await markShipped(id);
  if (!(await setStatusIf(id, "shipped", "cancelled"))) throw new Error("changed");
}
`,
      [
        t("shipOrCancel", "cancelled", { from: ["paid"] }),
        t("shipThenCancel", "cancelled", { from: ["shipped"] }),
        t("emailFirst", "cancelled", { from: ["shipped"] }),
      ],
      storageOf({
        update: [
          "src/repo.ts#setStatusIf",
          { fn: "src/repo.ts#markShipped", from: all, to: "shipped", returns: "throws" },
        ],
      }),
    );
    for (const name of ["shipOrCancel", "shipThenCancel"]) {
      const c = transitionOf(result, name);
      expect({ name, atomic: c.atomic, note: c.sites?.atomicNote }).toEqual({
        name,
        atomic: true,
        note: undefined,
      });
    }
    expect(transitionOf(result, "emailFirst").sites?.atomicNote?.message).toBe(
      "email.send can run although storage.setStatusIf found status changed: the call is not behind a check of the save's result",
    );
  });

  it("a call no spec effect maps to doesn't make the transition non-atomic", () => {
    const result = extract(
      `${IMPORTS}
export async function refundAfterLog(id: string) {
  await legacy.patch(id, {});
  if (!(await setStatusIf(id, "paid", "refunded"))) throw new Error("changed");
}
`,
      [t("refundAfterLog", "refunded")],
      storageOf({ update: ["src/repo.ts#setStatusIf"] }),
    );
    const s = transitionOf(result, "refundAfterLog");
    // legacy.patch is a bound client call, but not a spec effect: `undeclared-effect` says so.
    expect(s.sites?.effects.map((e) => e.gate)).toEqual(["legacy.patch"]);
    expect(s.atomic).toBe(true);
    expect(s.sites?.atomicNote).toBeUndefined();
  });

  it("`returns: count` also reads a count object (`r.count === 0`)", () => {
    const counted = extract(
      `${IMPORTS}
/** A conditional save that returns a count object, like Prisma's \`updateMany\`. */
export async function shipMany(id: string): Promise<{ count: number }> {
  return { count: (await markShipped(id)) ? 1 : 0 };
}
export async function shipChecked(id: string) {
  const r = await shipMany(id);
  if (r.count === 0) return;
  await email.send(id, "shipped");
}
export async function shipUnchecked(id: string) {
  const r = await shipMany(id);
  await email.send(id, "shipped");
  if (r.count < 1) return;
}
`,
      [t("shipChecked", "shipped"), t("shipUnchecked", "shipped")],
      storageOf({
        update: [{ fn: "src/impl.ts#shipMany", from: ["paid"], to: "shipped", returns: "count" }],
      }),
    );
    const checked = transitionOf(counted, "shipChecked");
    expect(checked.atomic).toBe(true);
    expect(checked.sites?.effects.map((e) => e.gate)).toEqual(["email.send"]);
    const unchecked = transitionOf(counted, "shipUnchecked");
    expect(unchecked.atomic).toBe(false);
    expect(unchecked.sites?.atomicNote?.message).toContain(
      "is not behind a check of the save's result",
    );
  });

  it("fixed from / to, and each `returns` kind's failure test", () => {
    const ship = transitionOf(result, "ship");
    expect(ship.from).toEqual(["paid"]);
    expect(ship.to).toBe("shipped");
    expect(ship.atomic).toBe(true);
    expect(ship.sites?.effects.map((e) => e.effect)).toEqual(["email.receipt"]);
    const entity = transitionOf(result, "refundEntity");
    expect(entity.atomic).toBe(true);
    expect(entity.from).toEqual(["paid"]);
    const cancel = transitionOf(result, "cancel");
    expect(cancel.atomic).toBe(true);
    expect(cancel.from).toEqual(["pending_payment"]);
  });

  it("a helper that returns the save's result passes the check to its caller", () => {
    const s = transitionOf(result, "refundViaHelper");
    expect(s.atomic).toBe(true);
    expect(s.sites?.function.name).toBe("doRefund");
    expect(s.sites?.invocation?.entityId).toEqual({ param: 0, path: [] });
  });
});

describe("helpers", () => {
  const result = extract(
    `${IMPORTS}
async function loadPaid(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "paid") throw new Error("not paid");
  return order;
}
async function markShippedAndSave(order: NonNullable<Awaited<ReturnType<typeof getOrder>>>) {
  order.status = "shipped";
  await saveOrder(order);
}
export async function ship(id: string) {
  await withTransaction(async () => {
    const order = await getOrder(id);
    if (order?.status !== "paid") throw new Error("not paid");
    await markShippedAndSave(order);
  });
}
export async function shipLeaky(id: string) {
  const order = await getOrder(id);
  if (order?.status !== "paid") throw new Error("not paid");
  await withTransaction(async () => {});
  await markShippedAndSave(order);
}
export async function shipViaLoader(id: string) {
  await withTransaction(async () => {
    const order = await loadPaid(id);
    order.status = "shipped";
    await saveOrder(order);
  });
}
`,
    [t("ship", "shipped"), t("shipLeaky", "shipped"), t("shipViaLoader", "shipped")],
  );

  it("a save inside a helper reached from inside the atomic callback: atomic", () => {
    const names = result.model?.transitions.map((x) => x.name);
    expect(names).toContain("ship");
    const s = transitionOf(result, "ship");
    expect(s.sites?.function.name).toBe("markShippedAndSave");
    expect(s.sites?.read?.gate).toBe("storage.getOrder");
    expect(s.sites?.commit?.gate).toBe("storage.saveOrder");
    expect(s.atomic).toBe(true);
    expect(s.sites?.atomic?.kind).toBe("declared");
  });

  it("the same helper reached from outside it: not atomic", () => {
    const s = transitionOf(result, "shipLeaky");
    expect(s.sites?.function.name).toBe("markShippedAndSave");
    expect(s.atomic).toBe(false);
  });

  it("a read returned by a helper called inside the callback: atomic", () => {
    const s = transitionOf(result, "shipViaLoader");
    expect(s.sites?.read).toMatchObject({ gate: "storage.getOrder", at: { line: 8 } });
    expect(s.atomic).toBe(true);
  });
});

describe("storage functions themselves", () => {
  it("are not looked into, and a binding that does not resolve is a broken link", () => {
    const result = extract(
      `${IMPORTS}
export async function ship(id: string) {
  if (!(await setStatusIf(id, "paid", "shipped"))) throw new Error("changed");
}
`,
      [t("ship", "shipped")],
      storageOf({
        read: ["src/repo.ts#getOrder"],
        update: ["src/repo.ts#setStatusIf", "src/repo.ts#noSuchFunction"],
      }),
    );
    expect(result.findings.map((f) => f.id)).toEqual([
      "broken-link:Fixture orders:storage:noSuchFunction",
    ]);
    // Only the impl's write: none inside repo.ts (markShipped, refundIf … call setStatusIf).
    expect(result.model?.transitions.map((x) => x.name).sort()).toEqual([
      "cancelOrThrow",
      "markShipped",
      "refundIf",
      "ship",
    ]);
  });

  it("tells `tsverify test` it can't fake a method of an interface", () => {
    const result = extract(
      `${IMPORTS}
import type { OrderStore } from "./repo";
export async function ship(deps: { orders: OrderStore }, id: string) {
  const order = await deps.orders.get(id);
  if (order?.status !== "paid") throw new Error("not paid");
  if (!(await setStatusIf(id, "paid", "shipped"))) throw new Error("changed");
}
`,
      [t("ship", "shipped")],
      storageOf({ read: ["src/repo.ts#OrderStore.get"], update: ["src/repo.ts#setStatusIf"] }),
    );
    expect(transitionOf(result, "ship").sites?.read?.gate).toBe("storage.OrderStore.get");
    expect(result.model?.unfakeable).toEqual([
      {
        binding: "storage.OrderStore.get",
        reason: "OrderStore.get is a method of OrderStore, a type, which has no value to replace",
      },
    ]);
  });

  it("a function that isn't exported is a broken link, but still read as bound", () => {
    const result = extract(
      `${IMPORTS}
async function findLocal(_db: unknown, id: string) {
  return getOrder(id);
}
export async function cancel(id: string) {
  const order = await findLocal(null, id);
  if (order?.status !== "pending_payment") throw new Error("not pending");
  await patchOrder(id, { status: "cancelled" });
}
`,
      [t("cancel", "cancelled", { from: ["pending_payment"] })],
      storageOf({
        read: [{ fn: "src/impl.ts#findLocal", args: ["_", "key"] }],
        save: [{ fn: "src/repo.ts#patchOrder", args: ["key", "patch"] }],
      }),
    );
    const f = result.findings.find((x) => x.id === "broken-link:Fixture orders:storage:findLocal");
    expect(f).toMatchObject({ severity: "error" });
    expect(f?.message).toBe(
      "storage read function src/impl.ts#findLocal is not exported: `tsverify test` replaces storage functions by mocking the module that exports them, so it can't replace this one",
    );
    const s = transitionOf(result, "cancel");
    expect(s.from).toEqual(["pending_payment"]);
    expect(s.sites?.read?.gate).toBe("storage.findLocal");
  });

  it("warns when a role's argument is an object of named arguments", () => {
    const result = extract(
      `${IMPORTS}
import { getByArgs } from "./repo";
export async function ship(id: string) {
  const order = await getByArgs({ id, tenant: "t1" });
  if (order?.status !== "paid") throw new Error("not paid");
  if (!(await setStatusIf(id, "paid", "shipped"))) throw new Error("changed");
}
`,
      [t("ship", "shipped")],
      storageOf({
        read: ["src/repo.ts#getByArgs"],
        update: ["src/repo.ts#setStatusIf"],
      }),
      true,
    );
    const f = result.findings.find((x) => x.id.endsWith(":binding:storage.getByArgs.args"));
    expect(f).toMatchObject({ severity: "warning" });
    expect(f?.message).toBe(
      "argument 1 of storage read function src/repo.ts#getByArgs is an object ({ id: string; tenant: string }), but its `key` role needs a string or number: tsverify can't tell which of its fields that is",
    );
    expect(f?.hint).toContain("aren't supported yet");
    // `from` as a list of states is fine.
    expect(result.findings.some((x) => x.id.includes("setStatusIf.args"))).toBe(false);
  });

  it("warns about a bound function (any kind) that no call resolves to", () => {
    const result = extract(
      `${IMPORTS}
export async function ship(id: string) {
  if (!(await setStatusIf(id, "paid", "shipped"))) throw new Error("changed");
}
`,
      [t("ship", "shipped")],
      storageOf({
        read: ["src/repo.ts#getOrder"],
        update: ["src/repo.ts#setStatusIf"],
        atomic: ["src/db.ts#withTransaction"],
      }),
      true,
    );
    // getOrder is called inside repo.ts (findOrder), setStatusIf by the impl: only the atomic
    // function is never called. (So are the bound clients, `stripe` …: a warning each.)
    const storage = result.findings.filter((f) => f.id.includes(":binding:storage."));
    expect(storage.map((f) => [f.id, f.severity, f.message])).toEqual([
      [
        "unanalyzable:Fixture orders:binding:storage.withTransaction",
        "warning",
        "storage atomic function src/db.ts#withTransaction is bound but never called: no call in the project resolves to it",
      ],
    ]);
    // Storage functions are not effect clients: only clients go into `uncalledClients`.
    expect(Object.keys(result.model?.uncalledClients ?? {})).toEqual(["email", "legacy", "stripe"]);
  });
});
