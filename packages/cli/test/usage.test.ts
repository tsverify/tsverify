import { describe, expect, it } from "vitest";
import { main } from "../src/main";
import { tsverify } from "./run";

describe("usage", () => {
  it("prints help on --help and exits 0", async () => {
    const r = await tsverify(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:\n  $ tsverify <command> [options]");
    expect(r.stdout).toContain("schema");
    expect(r.stderr).toBe("");
  });

  it("prints command help on <command> --help", async () => {
    const r = await tsverify(["schema", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("$ tsverify schema [options]");
  });

  it("documents check's code conformance flags", async () => {
    const r = await tsverify(["check", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("then check that the code conforms to them");
    expect(r.stdout).toMatch(/--spec-only +Check the specs only: skip code extraction/);
    expect(r.stdout).toMatch(
      /--project <path> +TypeScript project for all specs: its root directory, or its tsconfig file/,
    );
  });

  it("prints the version", async () => {
    const r = await tsverify(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\n$/);
  });

  it("rejects an unknown command with exit 2 and usage on stderr", async () => {
    const r = await tsverify(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error: unknown command `frobnicate`");
    expect(r.stderr).toContain("Usage:");
  });

  it("rejects a missing command with exit 2", async () => {
    const r = await tsverify([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error: missing command");
  });

  it("rejects an unknown flag with exit 2 and the command's usage on stderr", async () => {
    const r = await tsverify(["schema", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Unknown option `--bogus`");
    expect(r.stderr).toContain("$ tsverify schema [options]");
  });

  it("maps an unexpected exception to exit 3", async () => {
    // A failing stdout is the simplest way to make the tool itself throw.
    let stderr = "";
    const code = await main(["schema"], {
      stdout: () => {
        throw new Error("boom");
      },
      stderr: (s) => {
        stderr += s;
      },
      cwd: process.cwd(),
      isTTY: false,
      env: {},
    });
    expect(code).toBe(3);
    expect(stderr).toContain("internal error");
    expect(stderr).toContain("boom");
  });
});
