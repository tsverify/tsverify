import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadSpec } from "@tsverify/spec";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/actor";
import type { Order } from "../src/orders/order";
import type { Refund } from "../src/payments/stripe";
import {
  APP_ROOT,
  listVariants,
  materialize,
  overlayFiles,
  readManifest,
  VARIANTS_ROOT,
} from "./materialize";

const TSC = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const SPEC = "src/orders/order.behavior.yaml";
const ASSIGN_SPEC = fileURLToPath(new URL(`../../orders-app/${SPEC}`, import.meta.url));
const TYPECHECK_TIMEOUT = 60_000;

/** B1–B6 mirror examples/orders-app/variants; B7 is specific to conditional saves. */
const VARIANTS = [
  "b1-reopen",
  "b2-guard-bypass",
  "b3-refund-race",
  "b4-webhook-dup",
  "b5-undeclared-effect",
  "b6-spec-race",
  "b7-unchecked-receipt",
];

async function typecheck(root: string): Promise<void> {
  await promisify(execFile)(TSC, ["--noEmit", "-p", join(root, "tsconfig.json")], {
    timeout: TYPECHECK_TIMEOUT,
  });
}

it("lists the seeded-bug variants", async () => {
  expect(await listVariants()).toEqual(VARIANTS);
});

describe("the spec", () => {
  it("is the orders-app spec with bindings.storage naming the app's functions", async () => {
    const [functions, assign] = await Promise.all([
      loadSpec(SPEC, { root: APP_ROOT }),
      loadSpec(ASSIGN_SPEC, { root: join(ASSIGN_SPEC, "../../..") }),
    ]);
    expect(functions.findings).toEqual([]);
    const strip = (m: typeof functions.model) =>
      JSON.parse(JSON.stringify(m, (k, v) => (k === "at" || k.endsWith("At") ? undefined : v)));
    const { bindings, ...rest } = strip(functions.model);
    const { bindings: assignBindings, ...assignRest } = strip(assign.model);
    expect(rest).toEqual(assignRest);
    expect(bindings.persistence).toBeUndefined();
    expect(bindings.clients.db).toBeUndefined();
    expect(bindings.storage).toMatchObject({
      key: "id",
      read: [{ ref: { file: "src/store/orders.ts", symbol: "getOrder" }, args: ["key"] }],
      save: [{ ref: { file: "src/store/orders.ts", symbol: "saveOrder" }, args: ["entity"] }],
      update: [
        {
          ref: { file: "src/store/orders.ts", symbol: "updateStatusIf" },
          args: ["key", "from", "to", "patch"],
          returns: "entity",
        },
      ],
      atomic: [
        {
          ref: { file: "src/store/transaction.ts", symbol: "withTransaction" },
          args: ["callback"],
        },
      ],
    });
    expect(bindings.guards).toEqual(assignBindings.guards);
    expect(bindings.effects).toEqual(assignBindings.effects);
  });
});

describe("clean app", () => {
  it(
    "materializes without tests or variants and typechecks",
    async () => {
      const app = await materialize();
      try {
        await access(join(app.root, SPEC));
        await expect(access(join(app.root, "variants"))).rejects.toThrow();
        await expect(access(join(app.root, "test"))).rejects.toThrow();
        await typecheck(app.root);
      } finally {
        await app.dispose();
      }
    },
    TYPECHECK_TIMEOUT,
  );
});

describe.each(VARIANTS)("variant %s", (id) => {
  it("has a valid variant.json whose transitions exist", async () => {
    const manifest = await readManifest(id);
    const root = id === "b6-spec-race" ? join(VARIANTS_ROOT, id) : APP_ROOT;
    const { model } = await loadSpec(SPEC, { root });
    const known = model?.transitions.map((t) => t.name) ?? [];
    for (const finding of manifest.expected) {
      if (finding.transition !== undefined) expect(known).toContain(finding.transition);
    }
  });

  it("only replaces existing app files, and changes each one", async () => {
    const files = await overlayFiles(id);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const [original, replacement] = await Promise.all([
        readFile(join(APP_ROOT, file), "utf8"),
        readFile(join(VARIANTS_ROOT, id, file), "utf8"),
      ]);
      expect(replacement, file).not.toBe(original);
    }
  });

  it(
    "materializes with its overlay applied and typechecks",
    async () => {
      const app = await materialize(id);
      try {
        expect(app.overlay).toEqual(await overlayFiles(id));
        await typecheck(app.root);
      } finally {
        await app.dispose();
      }
    },
    TYPECHECK_TIMEOUT,
  );
});

interface Loaded {
  refundOrder(ctx: { actor: Actor }, orderId: string): Promise<Refund>;
  onPaymentSucceeded(event: { id: string; orderId: string; chargeId: string }): Promise<void>;
  saveOrder(order: Order): Promise<void>;
  stripeFake: typeof import("../src/payments/stripe").stripeFake;
  emailFake: typeof import("../src/notify/email").emailFake;
}

const ORDER = { id: "o1", ownerId: "c1", email: "c1@example.com", chargeId: "ch_1" } as const;

async function load(root: string): Promise<Loaded> {
  const module = (file: string): Promise<Partial<Loaded>> => import(join(root, file));
  const parts = await Promise.all(
    [
      "src/orders/refund.ts",
      "src/payments/webhook.ts",
      "src/store/orders.ts",
      "src/payments/stripe.ts",
      "src/notify/email.ts",
    ].map(module),
  );
  return Object.assign({}, ...parts) as Loaded;
}

describe("the races are real", () => {
  it("clean: two concurrent refunds pay out once, a redelivered event sends one receipt", async () => {
    const app = await materialize();
    try {
      const m = await load(app.root);
      await m.saveOrder({ ...ORDER, status: "paid" });
      const admin = { id: "a1", roles: ["admin"] as const };
      await Promise.allSettled([
        m.refundOrder({ actor: admin }, "o1"),
        m.refundOrder({ actor: admin }, "o1"),
      ]);
      expect(m.stripeFake.refunds()).toHaveLength(1);
      await m.saveOrder({ ...ORDER, id: "o2", status: "pending_payment" });
      const event = { id: "evt_1", orderId: "o2", chargeId: "ch_2" };
      await Promise.all([m.onPaymentSucceeded(event), m.onPaymentSucceeded(event)]);
      expect(m.emailFake.sent()).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });

  it("b3: two concurrent refunds both pay out", async () => {
    const app = await materialize("b3-refund-race");
    try {
      const m = await load(app.root);
      await m.saveOrder({ ...ORDER, status: "paid" });
      const admin = { id: "a1", roles: ["admin"] as const };
      await Promise.all([
        m.refundOrder({ actor: admin }, "o1"),
        m.refundOrder({ actor: admin }, "o1"),
      ]);
      expect(m.stripeFake.refunds()).toHaveLength(2);
    } finally {
      await app.dispose();
    }
  });

  it("b7: a redelivered event sends a second receipt", async () => {
    const app = await materialize("b7-unchecked-receipt");
    try {
      const m = await load(app.root);
      await m.saveOrder({ ...ORDER, status: "pending_payment" });
      const event = { id: "evt_1", orderId: "o1", chargeId: "ch_1" };
      await Promise.all([m.onPaymentSucceeded(event), m.onPaymentSucceeded(event)]);
      expect(m.emailFake.sent()).toHaveLength(2);
    } finally {
      await app.dispose();
    }
  });
});
