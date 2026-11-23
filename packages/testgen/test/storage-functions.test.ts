/**
 * Named storage functions (`bindings.storage`), end to end, on a small fixture app
 * (`fixtures/storage-app`): a repo module with `getOrder` / `saveOrder` / `setStatusIf` over a
 * plain Map, and `withTransaction` in `src/db.ts`.
 *
 * The code models come from the real extractor, run on a copy of the app (and of the variant).
 * They follow the `ir.StorageBinding` conventions: calls are `storage.<symbol>` call sites,
 * `persistence: "functions"`, a conditional save's atomic scope is `conditional-update`, a read and
 * save inside `withTransaction` is `declared`. The hand-written models these tests used before the
 * extractor recognised storage functions (`order.code.json`, and the variant's) stay as its
 * target: `packages/extractor/test/storage-app.test.ts` checks it produces them.
 *
 * - The spec is parsed from the YAML and the generated files are compared with goldens.
 * - The real checker finds the double refund in the variant's code model (read + save outside
 *   `withTransaction`); its counterexample becomes a replay test.
 * - The generated files run in a vitest subprocess against a copy of the app: every test passes
 *   on the clean app (the replay ends `replay-disagrees`: the conditional save stops the second
 *   refund), and on the variant the replay fails with verdict `confirmed`: Stripe refunds twice.
 */
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BehaviorModel, Finding } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { check } from "../../checker/src/index";
import { extractAll, loadTypeScript } from "../../extractor/src/index";
import { parseSpec } from "../../spec/src/index";
import { buildContext } from "../src/context";
import { generate } from "../src/index";

const APP = fileURLToPath(new URL("fixtures/storage-app/", import.meta.url));
const VARIANT = join(APP, "variants/read-save-refund");
const SPEC_FILE = "src/orders/order.behavior.yaml";
const OUT = ".tsverify/generated/order-lifecycle";
const RUNTIME = fileURLToPath(import.meta.resolve("@tsverify/runtime"));
const VITEST = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const RULE = "rule:Refund issued at most once per order";

/** The extractor's code model of a copy of the app, with `overlay`'s files over it. */
function extracted(overlay?: string): BehaviorModel {
  const root = mkdtempSync(join(tmpdir(), "tsverify-storage-app-extract-"));
  try {
    cpSync(join(APP, "src"), join(root, "src"), { recursive: true });
    if (overlay) cpSync(join(overlay, "src"), join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "es2022", module: "esnext", types: [] },
        include: ["src"],
      }),
    );
    const text = readFileSync(join(root, SPEC_FILE), "utf8");
    const parsed = parseSpec(text, SPEC_FILE).model;
    const typescript = loadTypeScript(APP);
    if (!parsed || "error" in typescript) throw new Error("fixture spec or TypeScript missing");
    const [result] = extractAll([parsed], { projectRoot: root, typescript: typescript.ts }).results;
    if (!result?.model || result.findings.length > 0) {
      throw new Error(`extractor: ${JSON.stringify(result?.findings)}`);
    }
    return result.model;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const clean = extracted();
const variant = extracted(VARIANT);

async function spec(): Promise<BehaviorModel> {
  const { model, findings } = parseSpec(await readFile(join(APP, SPEC_FILE), "utf8"), SPEC_FILE);
  expect(findings).toEqual([]);
  if (!model) throw new Error("fixture spec is invalid");
  return model;
}

/** Drops source locations, which the hand-written code models leave out of copied spec parts. */
function withoutAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAt);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== "at" && k !== "effectsAt")
      .map(([k, v]) => [k, withoutAt(v)]),
  );
}

/** The variant's counterexample: the real checker on its code model. */
function doubleRefund(): Finding {
  const finding = check(variant).findings.find((f) => f.property === RULE && f.trace);
  if (!finding) throw new Error("the checker found no double refund in the variant's code model");
  return finding;
}

interface VitestResult {
  name: string;
  status: string;
  failureMessages: string[];
  meta: { tsverifyReplay?: { verdict: string; effects: Record<string, number> } };
}

/** Copies the app (with the variant's files over it), writes the files, runs them with vitest. */
async function run(files: { path: string; content: string }[], overlay?: string) {
  const root = await mkdtemp(join(tmpdir(), "tsverify-storage-app-"));
  try {
    await cp(join(APP, "src"), join(root, "src"), { recursive: true });
    if (overlay) await cp(join(overlay, "src"), join(root, "src"), { recursive: true });
    for (const f of files) {
      const target = join(root, OUT, f.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content);
    }
    await writeFile(
      join(root, "vitest.config.mjs"),
      `export default ${JSON.stringify({
        resolve: { alias: { "@tsverify/runtime": RUNTIME } },
        test: { include: [`${OUT}/*.test.ts`], testTimeout: 20_000 },
      })};\n`,
    );
    const report = join(root, "report.json");
    await promisify(execFile)(
      process.execPath,
      [
        VITEST,
        "run",
        "--config",
        "vitest.config.mjs",
        "--maxWorkers=2",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      { cwd: root, env: { ...process.env, NO_COLOR: "1" } },
    ).catch(() => undefined); // failing tests exit 1; the report says which

    const json = JSON.parse(await readFile(report, "utf8")) as {
      testResults: { name: string; assertionResults: (VitestResult & { title: string })[] }[];
    };
    return json.testResults.flatMap((file) =>
      file.assertionResults.map((t) => ({
        file: file.name.slice(join(root, OUT).length + 1),
        name: t.title,
        status: t.status,
        failureMessages: t.failureMessages,
        meta: t.meta ?? {},
      })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("named storage functions: generated tests", () => {
  it("the code models copy the spec's bindings, storage included", async () => {
    const s = await spec();
    expect(clean.bindings).toEqual(s.bindings);
    expect(variant.bindings).toEqual(clean.bindings);
    expect(s.bindings.storage?.update[0]).toMatchObject({ args: ["key", "from", "to"] });
  });

  it("fakes the storage functions with instrument.storage, from bindings.storage", async () => {
    const { ctx, skipped } = buildContext({ spec: await spec(), code: clean, outDir: OUT });
    expect(skipped.filter((f) => !f.id.includes(":guards:"))).toEqual([]);
    expect(ctx?.stores).toEqual([]);
    expect(ctx?.prismas).toEqual([]);
    expect(ctx?.storage).toEqual({ client: "storage", collection: "Order", key: "id" });
    expect(ctx?.storageFunctions).toEqual({
      entity: "Order",
      state: "status",
      binding: withoutAt((await spec()).bindings.storage),
    });
    expect(ctx?.effects).toEqual([{ client: "stripe", calls: ["refunds.create"] }]);
    expect([...(ctx?.linked.keys() ?? [])]).toEqual(["pay", "refund", "ship"]);
  });

  it("mocks each storage function's module, replacing only the bound exports", async () => {
    const result = generate({ spec: await spec(), code: clean, findings: [], outDir: OUT });
    expect(result.files.map((f) => f.path)).toEqual(["paths.test.ts", "forbidden.test.ts"]);
    const paths = result.files[0]?.content ?? "";
    expect(paths).toContain(
      [
        'vi.mock("../../../src/orders/repo.ts", async (importOriginal) => ({',
        "  ...(await importOriginal<Record<string, unknown>>()),",
        "  getOrder: storage.functions.getOrder,",
        "  saveOrder: storage.functions.saveOrder,",
        "  setStatusIf: storage.functions.setStatusIf,",
        "}));",
      ].join("\n"),
    );
    expect(paths).toContain("  withTransaction: storage.functions.withTransaction,\n");
    await expect(paths).toMatchFileSnapshot("__golden__/storage-functions/paths.test.ts.txt");
  });

  it("mocks a dotted symbol as a member over the real export", async () => {
    const s = await spec();
    const storage = s.bindings.storage;
    if (!storage?.read[0]) throw new Error("fixture");
    storage.read[0] = {
      ...storage.read[0],
      ref: { file: "src/orders/repo.ts", symbol: "repo.get" },
    };
    const paths = generate({ spec: s, code: clean, findings: [], outDir: OUT }).files[0]?.content;
    expect(paths).toContain(
      [
        'vi.mock("../../../src/orders/repo.ts", async (importOriginal) => {',
        "  const original = await importOriginal<Record<string, any>>();",
        "  return {",
        "    ...original,",
        '    repo: Object.assign(Object.create(original.repo), { get: storage.functions["repo.get"] }),',
        "    saveOrder: storage.functions.saveOrder,",
        "    setStatusIf: storage.functions.setStatusIf,",
        "  };",
        "});",
      ].join("\n"),
    );
  });

  it("skips the tests when the code uses storage functions the spec does not name", async () => {
    const s = await spec();
    delete s.bindings.storage;
    const result = generate({ spec: s, code: clean, findings: [], outDir: OUT });
    expect(result.files).toEqual([]);
    expect(result.skipped.map((f) => f.message)).toContain(
      "tsverify test generated no tests: the code stores the Order through named storage functions (client `storage`), but the spec's `bindings.storage` does not name them",
    );
  });

  it("turns the checker's double refund on read + save into a replay test", async () => {
    const finding = doubleRefund();
    expect(finding.trace?.model).toBe("code");
    const result = generate({
      spec: await spec(),
      code: variant,
      findings: [finding],
      outDir: OUT,
    });
    const replay = result.files.find((f) => f.path === "replay-1.test.ts")?.content ?? "";
    expect(replay).toContain("refund#1 read   → [refund#1, storage.getOrder]");
    await expect(replay).toMatchFileSnapshot("__golden__/storage-functions/replay-1.test.ts.txt");
  });
});

describe("named storage functions: the generated files run", { timeout: 120_000 }, () => {
  it("clean app: every test passes; the conditional save stops the second refund", async () => {
    const finding = doubleRefund();
    const { files } = generate({
      spec: await spec(),
      code: clean,
      findings: [finding],
      outDir: OUT,
    });
    const results = await run(files);
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(results.map((r) => r.file)).toEqual(
      expect.arrayContaining(["paths.test.ts", "forbidden.test.ts", "replay-1.test.ts"]),
    );
    expect(results.filter((r) => r.file === "paths.test.ts").map((r) => r.name)).toEqual([
      "pay: pending → paid (no actor argument)",
      "refund: paid → refunded (no actor argument)",
      "ship: paid → shipped (no actor argument)",
    ]);
    const replay = results.find((r) => r.file === "replay-1.test.ts");
    expect(replay?.meta.tsverifyReplay).toMatchObject({
      verdict: "replay-disagrees",
      effects: { "stripe.refunds.create": 1 },
    });
  });

  it("read + save outside withTransaction: the replay reproduces the double refund", async () => {
    const finding = doubleRefund();
    const { files } = generate({
      spec: await spec(),
      code: variant,
      findings: [finding],
      outDir: OUT,
    });
    const results = await run(files, VARIANT);
    expect(results.filter((r) => r.status !== "passed").map((r) => r.file)).toEqual([
      "replay-1.test.ts",
    ]);
    const replay = results.find((r) => r.file === "replay-1.test.ts");
    expect(replay?.meta.tsverifyReplay).toMatchObject({
      verdict: "confirmed",
      effects: { "stripe.refunds.create": 2 },
    });
    expect(replay?.failureMessages.join("\n")).toContain(
      'confirmed: the real code violates rule "Refund issued at most once per order" (always: count(effect stripe.refund) <= 1)',
    );
  });
});
