/**
 * Every extraction starts one TypeScript 7 compiler process (`--api --cwd <project root>`) and
 * ends it before `extractAll` returns or throws. Each case uses a temp project of its own, so its
 * process is told apart from any other by its `--cwd`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BehaviorModel } from "@tsverify/ir";
import { afterAll, describe, expect, it } from "vitest";
import { extractAll, TypeScriptSetupError } from "../src/index";
import { loadProject } from "../src/project";
import { orderSpec } from "./helpers";
import { installTypeScript } from "./typescript";

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempProject(tsconfig: object): string {
  const root = mkdtempSync(join(tmpdir(), "tsverify-process-"));
  created.push(root);
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify(tsconfig),
    "src/order.ts": `export interface Order { id: string; status: "paid" | "refunded" }
export function refund(order: Order): void {
  if (order.status === "paid") order.status = "refunded";
}
`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Compiler processes started for `root` that are still running (zombies have ended). */
function running(root: string): string[] {
  const ps = execFileSync("ps", ["-eo", "stat=,args="], { encoding: "utf8" });
  return ps
    .split("\n")
    .filter((line) => line.includes(" --api ") && line.includes(`--cwd ${root}`))
    .filter((line) => !line.trimStart().startsWith("Z"));
}

/**
 * Compiler processes for `root` still running once they had time to exit: `close()` sends the
 * signal without waiting, so a closed process may take a moment to go; a leaked one never does.
 */
async function survivors(root: string): Promise<string[]> {
  const deadline = Date.now() + 5000;
  let left = running(root);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    left = running(root);
  }
  return left;
}

const OK = { compilerOptions: { strict: true, types: [] }, include: ["src"] };

function spec(): BehaviorModel {
  return orderSpec([
    { name: "refund", impl: "src/order.ts#refund", from: ["paid"], to: "refunded" },
  ]);
}

describe.skipIf(process.platform === "win32")("the compiler process", () => {
  it("runs while a project is loaded (so the checks below can see one)", async () => {
    installTypeScript();
    const root = tempProject(OK);
    const loaded = loadProject(root);
    if ("error" in loaded) throw new Error(loaded.error);
    try {
      expect(running(root)).toHaveLength(1);
    } finally {
      loaded.close();
    }
    expect(await survivors(root)).toEqual([]);
  });

  it("is ended after an extraction", async () => {
    const root = tempProject(OK);
    const { results, stats } = extractAll([spec()], { projectRoot: root });
    expect(stats.probes).toBe(1);
    expect(results[0]?.model?.transitions.map((t) => t.name)).toEqual(["refund"]);
    expect(await survivors(root)).toEqual([]);
  });

  it("is ended when the tsconfig is rejected", async () => {
    const root = tempProject({ ...OK, compilerOptions: { ...OK.compilerOptions, baseUrl: "." } });
    expect(() => extractAll([spec()], { projectRoot: root })).toThrow(TypeScriptSetupError);
    expect(await survivors(root)).toEqual([]);
  });

  it("is ended when the extraction throws", async () => {
    const root = tempProject(OK);
    const broken = { ...spec(), entity: undefined } as unknown as BehaviorModel;
    expect(() => extractAll([broken], { projectRoot: root })).toThrow(TypeError);
    expect(await survivors(root)).toEqual([]);
  });
});
