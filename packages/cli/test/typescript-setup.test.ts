import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { tsverify } from "./run";
import { tempSpecDir } from "./temp-specs";

// The monorepo has `@typescript/typescript6`, which the loader's last step (tsverify's own
// install location) would find. Resolve that step from the project instead, as an install
// without a usable TypeScript would.
vi.mock("@tsverify/extractor", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tsverify/extractor")>();
  return {
    ...original,
    loadTypeScript: (root: string) =>
      original.loadTypeScript(root, pathToFileURL(join(root, "tsverify.js"))),
  };
});

const SPEC = `behavior: Light
entity:
  name: Light
  state: status
  states: [off, on]
  initial: off
  terminal: [on]
actors:
  user: { trust: authenticated }
transitions:
  switch_on:
    from: off
    to: on
    by: user
    impl: src/light.ts#switchOn
`;

const CODE = `export function switchOn(light: { status: "off" | "on" }): void {
  light.status = "on";
}
`;

/** A project whose only TypeScript is 7.0.2: the `typescript` entry has no compiler API. */
function ts7Project(): Record<string, string> {
  return {
    "tsconfig.json": `{ "include": ["src"] }\n`,
    "src/light.ts": CODE,
    "src/light.behavior.yaml": SPEC,
    "node_modules/typescript/package.json": `{ "name": "typescript", "version": "7.0.2", "main": "version.cjs" }\n`,
    "node_modules/typescript/version.cjs": `module.exports = { version: "7.0.2" };\n`,
  };
}

describe("check: no TypeScript with the compiler API", () => {
  it("exits 2 and names the project's TypeScript version and the fix", async () => {
    const cwd = await tempSpecDir(ts7Project());
    const r = await tsverify(["check"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: tsverify needs the TypeScript compiler API to read your code. This project has " +
        "TypeScript 7.0.2, which no longer includes it: add `@typescript/typescript6` as a " +
        "devDependency (`npm i -D @typescript/typescript6`). TypeScript 5.4–6.x projects need " +
        "nothing extra.\n",
    );
  });

  it("still checks the spec alone with --spec-only", async () => {
    const cwd = await tempSpecDir(ts7Project());
    const r = await tsverify(["check", "--spec-only"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});
