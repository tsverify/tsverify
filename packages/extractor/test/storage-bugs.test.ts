/**
 * Planted bugs in an app whose storage is its own functions (`bindings.storage`), each found by
 * the real `tsverify check` (in-process, through `@tsverify/cli`'s `main`) on a copy of
 * `fixtures/storage-bugs` with the bug's variant applied. The clean app has no findings.
 *
 * | Variant | Bug | Finding |
 * |---|---|---|
 * | v1-non-atomic | ship reads and saves outside `withTransaction` | `non-atomic` (ship) |
 * | v2-from-mismatch | the conditional save also accepts `shipped` | `from-state-mismatch` (refund) |
 * | v3-missing-guard | cancel never calls `requireRole` | `guard-not-dominating` (cancel) |
 * | v4-effect-before-check | Stripe refunds before the save's result is checked | `non-atomic` (refund), and the double refund |
 * | v5-unbound-write | cancel writes through an unbound data layer | `unanalyzable` (storage, cancel) |
 * | v6-helper-save | a helper that reads and saves is called outside `withTransaction` | `non-atomic` (ship) |
 */
import { fileURLToPath } from "node:url";
import type { Finding } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { exampleApp, matchesExpected } from "../../../examples/shared/materialize";
import { type Io, main } from "../../cli/src/main";

const app = exampleApp(fileURLToPath(new URL("./fixtures/storage-bugs/", import.meta.url)));
const VARIANTS = await app.listVariants();

async function check(variant: string | undefined, format = "json") {
  const copy = await app.materialize(variant);
  try {
    const out = { stdout: "", stderr: "" };
    const io: Io = {
      stdout: (s) => {
        out.stdout += s;
      },
      stderr: (s) => {
        out.stderr += s;
      },
      cwd: copy.root,
      isTTY: false,
      env: {},
    };
    const code = await main(["check", "src", "--format", format], io);
    return { code, ...out };
  } finally {
    await copy.dispose();
  }
}

function ids(stdout: string): string[] {
  return (JSON.parse(stdout) as { findings: Finding[] }).findings.map(
    (f) => `${f.severity} ${f.id}`,
  );
}

describe("tsverify check on planted storage-function bugs", { timeout: 60_000 }, () => {
  it("the clean app has no findings", async () => {
    const run = await check(undefined);
    expect(run.stderr).toBe("");
    expect(ids(run.stdout)).toEqual([]);
    expect(run.code).toBe(0);
  });

  it.each(VARIANTS)("%s: its expected findings", async (variant) => {
    const manifest = await app.readManifest(variant);
    const run = await check(variant);
    expect(run.stderr).toBe("");
    const findings = (JSON.parse(run.stdout) as { findings: Finding[] }).findings;
    for (const expected of manifest.expected) {
      expect(
        findings.some((f) => matchesExpected(f, expected)),
        `no finding matches ${JSON.stringify(expected)}: ${ids(run.stdout).join(", ")}`,
      ).toBe(true);
    }
  });

  it("every variant gives exactly these findings", async () => {
    const all: Record<string, string[]> = {};
    for (const v of VARIANTS) all[v] = ids((await check(v)).stdout);
    expect(all).toEqual({
      "v1-non-atomic": ["error non-atomic:Storage bugs:ship"],
      "v2-from-mismatch": ["error from-state-mismatch:Storage bugs:refund:shipped"],
      "v3-missing-guard": ["error guard-not-dominating:Storage bugs:cancel:role(admin)"],
      "v4-effect-before-check": [
        "error non-atomic:Storage bugs:refund",
        "error implementation-property:Storage bugs:rule:Refund issued at most once per order",
        "error implementation-property:Storage bugs:effect-multiplicity:stripe.refund",
      ],
      // Like a read the assign adapter cannot find: unanalyzable, and not atomic.
      "v5-unbound-write": [
        "warning unanalyzable:Storage bugs:storage:cancel",
        "error non-atomic:Storage bugs:cancel",
      ],
      "v6-helper-save": ["error non-atomic:Storage bugs:ship"],
    });
  });
});
