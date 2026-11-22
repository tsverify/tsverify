import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadSpec } from "@tsv/spec";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/actor";
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

/** B1–B6 mirror examples/orders-app/variants; B7 is Prisma-specific. */
const VARIANTS = [
  "b1-reopen",
  "b2-guard-bypass",
  "b3-refund-race",
  "b4-webhook-dup",
  "b5-undeclared-effect",
  "b6-spec-race",
  "b7-tx-read-committed",
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
  it("is the orders-app spec with Prisma bindings", async () => {
    const [prisma, assign] = await Promise.all([
      loadSpec(SPEC, { root: APP_ROOT }),
      loadSpec(ASSIGN_SPEC, { root: join(ASSIGN_SPEC, "../../..") }),
    ]);
    expect(prisma.findings).toEqual([]);
    const strip = (m: typeof prisma.model) =>
      JSON.parse(JSON.stringify(m, (k, v) => (k === "at" || k.endsWith("At") ? undefined : v)));
    const { bindings, ...rest } = strip(prisma.model);
    const { bindings: assignBindings, ...assignRest } = strip(assign.model);
    expect(rest).toEqual(assignRest);
    expect(bindings.persistence).toBe("prisma");
    expect(bindings.clients.prisma).toMatchObject({ module: "src/db.ts", export: "prisma" });
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
  prisma: typeof import("../src/db").prisma;
  stripeFake: typeof import("../src/payments/stripe").stripeFake;
}

describe.each(["b3-refund-race", "b7-tx-read-committed"])("%s is a real race", (id) => {
  it("two concurrent refunds both pay out against the stand-in client", async () => {
    const app = await materialize(id);
    try {
      const module = <T>(file: string): Promise<T> => import(join(app.root, file));
      const { refundOrder } = await module<Loaded>("src/orders/refund.ts");
      const { prisma } = await module<Loaded>("src/db.ts");
      const { stripeFake } = await module<Loaded>("src/payments/stripe.ts");
      await prisma.order.create({
        data: {
          id: "o1",
          ownerId: "c1",
          email: "c1@example.com",
          status: "paid",
          chargeId: "ch_1",
        },
      });
      const admin = { id: "a1", roles: ["admin"] as const };
      await Promise.all([refundOrder({ actor: admin }, "o1"), refundOrder({ actor: admin }, "o1")]);
      expect(stripeFake.refunds()).toHaveLength(2);
    } finally {
      await app.dispose();
    }
  });
});
