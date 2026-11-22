import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadTypeScript } from "../src/index";
import { FIXTURES } from "./helpers";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const require = createRequire(import.meta.url);
/** Real package directories, linked into temp projects. */
const TS59 = dirname(require.resolve("typescript59/package.json"));
const TS6 = dirname(require.resolve("@typescript/typescript6/package.json"));

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temp project: `files` (path → text) and `links` (node_modules package → real directory). */
async function project(
  files: Record<string, string>,
  links: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsverify-load-ts-"));
  created.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  for (const [name, target] of Object.entries(links)) {
    const at = join(dir, "node_modules", name);
    await mkdir(dirname(at), { recursive: true });
    await symlink(target, at, "dir");
  }
  return dir;
}

/** A fake `typescript` package: version 7.0.2 without the compiler API, or an old classic one. */
function fakeTypeScript(version: string, classic: boolean): Record<string, string> {
  const api = classic ? ", createProgram() {}" : "";
  return {
    "node_modules/typescript/package.json": `{ "name": "typescript", "version": "${version}", "main": "index.cjs" }`,
    "node_modules/typescript/index.cjs": `module.exports = { version: "${version}"${api} };`,
  };
}

/** Loads with tsverify's own location inside the project, so the monorepo's TypeScript is out. */
function loadAlone(root: string) {
  return loadTypeScript(root, pathToFileURL(join(root, "tsverify.js")));
}

const HEADLINE = "tsverify needs the TypeScript compiler API to read your code.";

describe("loadTypeScript", () => {
  it("uses @typescript/typescript6 in this TS-7 monorepo", () => {
    const loaded = loadTypeScript(FIXTURES);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toMatch(/^6\./);
    expect(typeof loaded.ts.createProgram).toBe("function");
  });

  it("prefers the project's classic typescript", async () => {
    const root = await project({}, { typescript: TS59 });
    const loaded = loadAlone(root);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toBe("5.9.3");
    expect(loaded.ts.version).toBe("5.9.3");
  });

  it("falls back to the project's @typescript/typescript6 when typescript is 7", async () => {
    const root = await project(fakeTypeScript("7.0.2", false), {
      "@typescript/typescript6": TS6,
    });
    const loaded = loadAlone(root);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toMatch(/^6\./);
  });

  it("falls back to tsverify's own install location", async () => {
    const root = await project(fakeTypeScript("7.0.2", false));
    const self = await project({}, { typescript: TS59 });
    const loaded = loadTypeScript(root, pathToFileURL(join(self, "tsverify.js")));
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toBe("5.9.3");
  });

  it("names TypeScript 7 and the fix when nothing has the compiler API", async () => {
    const root = await project(fakeTypeScript("7.0.2", false));
    expect(loadAlone(root)).toEqual({
      error: `${HEADLINE} This project has TypeScript 7.0.2, which no longer includes it: add \`@typescript/typescript6\` as a devDependency (\`npm i -D @typescript/typescript6\`). TypeScript 5.4–6.x projects need nothing extra.`,
      projectVersion: "7.0.2",
    });
  });

  it("rejects TypeScript older than 5.4", async () => {
    const root = await project(fakeTypeScript("5.3.3", true));
    expect(loadAlone(root)).toEqual({
      error: `${HEADLINE} This project has TypeScript 5.3.3, and tsverify supports 5.4 or later: upgrade it, or add \`@typescript/typescript6\` as a devDependency (\`npm i -D @typescript/typescript6\`).`,
      projectVersion: "5.3.3",
    });
  });

  it("reports a project without TypeScript", async () => {
    const root = await project({});
    const loaded = loadAlone(root);
    expect(loaded).toEqual({
      error: `${HEADLINE} No TypeScript is installed for ${root}: add \`@typescript/typescript6\` as a devDependency (\`npm i -D @typescript/typescript6\`), or \`typescript\` 5.4–6.x.`,
    });
  });
});

describe("extractor sources", () => {
  it("import TypeScript for types only: the module comes from loadTypeScript", async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const offending: string[] = [];
    for (const file of files) {
      const text = await readFile(join(SRC, file), "utf8");
      const value = /^import (?!type )[^;]*from "(typescript|@typescript\/[^"]+|ts-morph)";/m;
      if (value.test(text)) offending.push(file);
    }
    expect(offending).toEqual([]);
  });
});
