/**
 * End-to-end: `tsverify test` on a project (test/fixtures/custom-conditions) whose impl imports a
 * workspace package, `@acme/templates`, that resolves to its sources only with the tsconfig's
 * `customConditions` (its `default` export points at a `dist/` that was never built). The
 * generated tests must resolve it the same way; without the condition, the failure is reported
 * as a setup problem, not as a behavior the spec forbids. Runs as a subprocess, like
 * e2e/test-command.test.ts.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { JsonReport } from "../../src/output/json";

const BIN = fileURLToPath(new URL("../../bin/tsverify.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/custom-conditions", import.meta.url));

async function run(root: string): Promise<{ code: number; doc: JsonReport; stderr: string }> {
  const { code, stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [BIN, "test", "src", "--format", "json"],
    { cwd: root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined } },
  ).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
  return { code, doc: JSON.parse(stdout) as JsonReport, stderr };
}

describe("tsverify test: a workspace package resolved with customConditions", {
  timeout: 60_000,
}, () => {
  it("resolves it in the generated tests, and reports a setup failure without the condition", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsverify-custom-conditions-"));
    try {
      await cp(FIXTURE, root, { recursive: true });
      // The workspace link a package manager would make.
      await mkdir(join(root, "node_modules/@acme"), { recursive: true });
      await symlink("../../packages/templates", join(root, "node_modules/@acme/templates"));

      const ok = await run(root);
      expect(ok.stderr).toBe("");
      expect(ok.doc.findings).toEqual([]);
      expect(ok.doc.specs[0]?.generated?.tests).toEqual({
        total: 3,
        passed: 3,
        failed: 0,
        missing: 0,
      });

      const tsconfig = join(root, "tsconfig.json");
      const text = await readFile(tsconfig, "utf8");
      await writeFile(tsconfig, text.replace(/\s*"customConditions": \[[^\]]*\],/, ""));
      const broken = await run(root);
      expect(broken.code).toBe(1);
      expect(broken.doc.findings).toEqual([
        expect.objectContaining({
          id: "generated-test-failed:Parcel delivery:setup:paths.test.ts",
          message: expect.stringContaining(
            'could not start (3 tests), before any of the code under test ran: Failed to resolve entry for package "@acme/templates"',
          ),
          hint: expect.stringMatching(/^A setup problem, not a behavior the spec forbids\./),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
