/**
 * End-to-end: `tsverify test` on a project (test/fixtures/shared-module) whose client module also
 * exports a guard: `src/services.ts` exports `sendMail`, the `email` client bound as a bare
 * function (call sites with `path: ""`, gate `email`), and `requireOwner`, the `owner` guard.
 * The generated mocks must replace only `sendMail`, with a recording fake function, and keep
 * `requireOwner` real. Runs as a subprocess, like e2e/test-command.test.ts.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { JsonReport } from "../../src/output/json";

const BIN = fileURLToPath(new URL("../../bin/tsverify.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/shared-module", import.meta.url));
const GENERATED = ".tsverify/generated/parcel-delivery";

describe("tsverify test: a guard beside a client bound as a function", { timeout: 60_000 }, () => {
  it("mocks only the bound export, so the guard stays real and the email is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsverify-shared-module-"));
    try {
      await cp(FIXTURE, root, { recursive: true });
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [BIN, "test", "src", "--format", "json"],
        { cwd: root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined } },
      );
      expect(stderr).toBe("");
      const doc = JSON.parse(stdout) as JsonReport;
      expect(doc.findings).toEqual([]);
      expect(doc.specs).toEqual([
        expect.objectContaining({
          generated: { dir: GENERATED, tests: { total: 3, passed: 3, failed: 0, missing: 0 } },
        }),
      ]);
      const paths = await readFile(join(root, GENERATED, "paths.test.ts"), "utf8");
      expect(paths).toContain(
        'const email = instrument.effects(s, { client: "email", calls: [""] });',
      );
      expect(paths).toContain(
        [
          'vi.mock("../../../src/services.ts", async (importOriginal) => ({',
          "  ...(await importOriginal<Record<string, unknown>>()),",
          "  sendMail: email.client,",
          "}));",
        ].join("\n"),
      );
      // The gate replay and the effect assertions use is the client name itself.
      expect(paths).toContain(
        'expect(calls("email"), "email.shipped (exactly-once) via email").toBe(1);',
      );
      const guards = await readFile(join(root, GENERATED, "guards.test.ts"), "utf8");
      expect(guards).toContain(
        'test("ship as courier (not in by: customer) is rejected from packed"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
