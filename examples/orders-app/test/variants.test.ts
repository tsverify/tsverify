import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadSpec } from "@tsv/spec";
import { describe, expect, it } from "vitest";
import {
  APP_ROOT,
  listVariants,
  materialize,
  overlayFiles,
  parseManifest,
  readManifest,
  VARIANTS_ROOT,
} from "./materialize";

const TSC = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const SPEC = "src/orders/order.behavior.yaml";
const TYPECHECK_TIMEOUT = 60_000;

const VARIANTS = [
  "b1-reopen",
  "b2-guard-bypass",
  "b3-refund-race",
  "b4-webhook-dup",
  "b5-undeclared-effect",
  "b6-spec-race",
];

async function typecheck(root: string): Promise<void> {
  await promisify(execFile)(TSC, ["--noEmit", "-p", join(root, "tsconfig.json")], {
    timeout: TYPECHECK_TIMEOUT,
  });
}

async function transitionNames(root: string): Promise<string[]> {
  const { model, findings } = await loadSpec(SPEC, { root });
  expect(findings).toEqual([]);
  return model?.transitions.map((t) => t.name) ?? [];
}

it("lists the six seeded-bug variants", async () => {
  expect(await listVariants()).toEqual(VARIANTS);
});

describe("clean app", () => {
  it(
    "materializes without tests or variants and typechecks",
    async () => {
      const app = await materialize();
      try {
        expect(app.overlay).toEqual([]);
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
    expect(manifest.id).toBe(id);
    const known = await transitionNames(id === "b6-spec-race" ? join(VARIANTS_ROOT, id) : APP_ROOT);
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
        for (const file of app.overlay) {
          const [applied, source] = await Promise.all([
            readFile(join(app.root, file), "utf8"),
            readFile(join(VARIANTS_ROOT, id, file), "utf8"),
          ]);
          expect(applied, file).toBe(source);
        }
        await expect(access(join(app.root, "variant.json"))).rejects.toThrow();
        await typecheck(app.root);
      } finally {
        await app.dispose();
      }
    },
    TYPECHECK_TIMEOUT,
  );
});

describe("b6-spec-race spec", () => {
  it("differs from the clean spec only in refund's atomic flag", async () => {
    const [clean, b6] = await Promise.all([
      loadSpec(SPEC, { root: APP_ROOT }),
      loadSpec(SPEC, { root: join(VARIANTS_ROOT, "b6-spec-race") }),
    ]);
    const atomic = (r: typeof clean) =>
      Object.fromEntries((r.model?.transitions ?? []).map((t) => [t.name, t.atomic]));
    expect(atomic(clean)).toMatchObject({ refund: true });
    expect(atomic(b6)).toEqual({ ...atomic(clean), refund: false });
  });
});

describe("parseManifest", () => {
  const valid = { id: "x", bug: "one line", expected: [{ category: "non-atomic" }] };

  it("accepts a minimal manifest", () => {
    expect(parseManifest(valid)).toEqual(valid);
  });

  it.each([
    ["an unknown category", { ...valid, expected: [{ category: "nonatomic" }] }, "category"],
    ["an unknown finding key", { ...valid, expected: [{ category: "non-atomic", x: "y" }] }, "x"],
    ["no expected findings", { ...valid, expected: [] }, "non-empty"],
    ["a multi-line bug", { ...valid, bug: "a\nb" }, "one line"],
    ["an unknown top-level key", { ...valid, extra: 1 }, "extra"],
  ])("rejects %s", (_, manifest, message) => {
    expect(() => parseManifest(manifest)).toThrow(message);
  });
});
