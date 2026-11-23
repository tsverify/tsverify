/**
 * End-to-end: `tsverify test` on a project (test/fixtures/stand-in-tx) whose storage functions
 * live in modules that open a connection as they load, with a fallback only under
 * `NODE_ENV=test` (src/db.ts), and whose atomic function passes its callback a transaction.
 *
 * - The generated mocks load the real modules (`importOriginal`), so the run must set the
 *   environment as the `vitest` command does: without `NODE_ENV=test` every test fails to start.
 * - `ship` passes the transaction only to bound storage functions: its tests pass.
 * - `cancel` also writes an audit row through `tx.insert` in code the spec doesn't bind: its path
 *   test fails, saying so, instead of crashing on `undefined`.
 *
 * Runs as a subprocess, like e2e/test-command.test.ts, with `NODE_ENV` unset.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { JsonReport } from "../../src/output/json";

const BIN = fileURLToPath(new URL("../../bin/tsverify.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/stand-in-tx", import.meta.url));

describe("tsverify test: an atomic function's transaction and a module that needs NODE_ENV=test", {
  timeout: 60_000,
}, () => {
  it("loads the mocked modules, passes a stand-in transaction, and names its unbound use", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsverify-stand-in-tx-"));
    try {
      await cp(FIXTURE, root, { recursive: true });
      const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined, NODE_ENV: undefined };
      const run = await promisify(execFile)(
        process.execPath,
        [BIN, "test", "src", "--format", "json"],
        { cwd: root, env },
      ).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (e: { code: number; stdout: string; stderr: string }) => e,
      );
      expect(run.stderr).toBe("");
      expect(run.code).toBe(1);
      const doc = JSON.parse(run.stdout) as JsonReport;
      expect(doc.specs[0]?.generated?.tests).toEqual({
        total: 6,
        passed: 5,
        failed: 1,
        missing: 0,
      });
      expect(doc.findings.map((f) => f.id)).toEqual([
        "generated-test-failed:Order shipping:path:cancel:paid",
      ]);
      const [failed] = doc.findings;
      expect(failed?.message).toBe(
        "Generated path test \"cancel: paid → canceled (as clerk)\" failed: tsverify's stand-in transaction: `tx.insert` was used by code the spec doesn't bind. storage.withTransaction passes its callback this stand-in in place of the real transaction (or lock handle), and only the functions the spec binds are replaced by fakes; bind the function that uses it (a storage function under `bindings.storage`, or a client under `bindings.clients`), so the test replaces it.",
      );
      expect(failed?.hint).toMatch(/^A gap in the bindings, not necessarily a bug in the code/);
      // JSON keeps the whole error: here, the stack through the unbound function.
      expect(failed?.detail).toMatch(/^StandInTransactionError: /);
      expect(failed?.detail).toContain("at writeAudit (");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
