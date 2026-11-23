import { readFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { tsverify } from "./run";
import { tempSpecDir } from "./temp-specs";

// The monorepo has TypeScript 7, which the loader's last step (tsverify's own install location)
// would find. Resolve that step from the project instead, as an install without a usable
// TypeScript would.
vi.mock("@tsverify/extractor", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tsverify/extractor")>();
  return {
    ...original,
    loadTypeScript: (root: string) =>
      original.loadTypeScript(root, pathToFileURL(join(root, "tsverify.js"))),
  };
});

/** The monorepo's TypeScript 7 package directory, linked into temp projects. */
const TS7_MANIFEST = createRequire(import.meta.url).resolve("typescript/package.json");
const TS7 = dirname(TS7_MANIFEST);
const TS7_VERSION = (JSON.parse(readFileSync(TS7_MANIFEST, "utf8")) as { version: string }).version;

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

const CODE = `export interface Light {
  status: "off" | "on";
}

export function switchOn(light: Light): void {
  if (light.status === "off") light.status = "on";
}
`;

function lightProject(tsconfig = `{ "include": ["src"] }\n`): Record<string, string> {
  return { "tsconfig.json": tsconfig, "src/light.ts": CODE, "src/light.behavior.yaml": SPEC };
}

/** A project whose only TypeScript is 5.9.3: no TypeScript 7 API. */
function ts59Project(): Record<string, string> {
  return {
    ...lightProject(),
    "node_modules/typescript/package.json": `{ "name": "typescript", "version": "5.9.3", "main": "typescript.js" }\n`,
    "node_modules/typescript/typescript.js": `module.exports = { version: "5.9.3" };\n`,
  };
}

/** A project with the monorepo's TypeScript 7 installed. */
async function ts7Project(files: Record<string, string>): Promise<string> {
  const cwd = await tempSpecDir(files);
  await mkdir(join(cwd, "node_modules"), { recursive: true });
  await symlink(TS7, join(cwd, "node_modules", "typescript"), "dir");
  return cwd;
}

const HEADLINE = "error: tsverify needs TypeScript 7 or later to read your code.";

describe("check: no TypeScript 7", () => {
  it("exits 2 and names the project's TypeScript version and the fix", async () => {
    const cwd = await tempSpecDir(ts59Project());
    const r = await tsverify(["check"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `${HEADLINE} This project has TypeScript 5.9.3: upgrade it with \`npm i -D typescript@latest\`.\n`,
    );
  });

  it("exits 2 and says how to add TypeScript when there is none", async () => {
    const cwd = await tempSpecDir(lightProject());
    const r = await tsverify(["check"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      `${HEADLINE} No TypeScript is installed for ${cwd}: add it with \`npm i -D typescript\`.\n`,
    );
  });

  it("still checks the spec alone with --spec-only", async () => {
    const cwd = await tempSpecDir(ts59Project());
    const r = await tsverify(["check", "--spec-only"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("check: a tsconfig TypeScript 7 rejects", () => {
  it("exits 2 with TypeScript's message and a hint", async () => {
    const tsconfig = `{ "compilerOptions": { "moduleResolution": "node10" }, "include": ["src"] }\n`;
    const cwd = await ts7Project(lightProject(tsconfig));
    const r = await tsverify(["check"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: TypeScript ${TS7_VERSION} rejects ${cwd}/tsconfig.json: Option 'moduleResolution=node10' has been removed. Please remove it from your configuration. TypeScript 7 removed some older tsconfig options (such as \`baseUrl\` and \`moduleResolution: node10\`) that TypeScript 6 only deprecated; fix the tsconfig until \`tsc --noEmit\` accepts it.\n`,
    );
  });

  it("checks the project once the tsconfig is fixed", async () => {
    const cwd = await ts7Project(lightProject());
    const r = await tsverify(["check"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});
