import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/tsverify.js", import.meta.url));

// The only subprocess test (slow): proves the launcher runs the TypeScript sources under plain node.
it("bin/tsverify.js runs under node", { timeout: 60_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, "--help"]);
  expect(stdout).toContain("$ tsverify <command> [options]");
});
