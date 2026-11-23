import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadTypeScript, loadTypeScriptPackage } from "../src/index";
import { FIXTURES } from "./helpers";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const require = createRequire(import.meta.url);
/** The real TypeScript 7.1 package directory (the `typescript71` alias), linked into temp projects. */
const TS71 = dirname(require.resolve("typescript71/package.json"));

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

/** A fake `typescript` package of `version`, with `files` (path in the package → text). */
function fakeTypeScript(
  version: string,
  exports: Record<string, string> = {},
  files: Record<string, string> = {},
): Record<string, string> {
  const manifest = {
    name: "typescript",
    version,
    exports: { "./package.json": "./package.json", ".": "./version.cjs", ...exports },
  };
  return {
    "node_modules/typescript/package.json": JSON.stringify(manifest),
    "node_modules/typescript/version.cjs": `module.exports = { version: "${version}" };`,
    ...Object.fromEntries(
      Object.entries(files).map(([path, text]) => [`node_modules/typescript/${path}`, text]),
    ),
  };
}

/** Loads with tsverify's own location inside the project, so the monorepo's TypeScript is out. */
function loadAlone(root: string) {
  return loadTypeScript(root, pathToFileURL(join(root, "tsverify.js")));
}

const HEADLINE = "tsverify needs TypeScript 7 or later to read your code.";

describe("loadTypeScript", () => {
  it("uses the monorepo's TypeScript 7", () => {
    const loaded = loadTypeScript(FIXTURES);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toMatch(/^7\./);
    expect(typeof loaded.ts.sync.API).toBe("function");
    expect(typeof loaded.ts.ast.isIdentifier).toBe("function");
  });

  it("prefers the project's own TypeScript, through the stable entry points of 7.1", async () => {
    const root = await project({}, { typescript: TS71 });
    const loaded = loadAlone(root);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toBe("7.1.0-beta");
    expect(loaded.path).toBe(require.resolve("typescript71/sync"));
  });

  it("falls back to tsverify's own install location when the project has no TypeScript", async () => {
    const root = await project({});
    const self = await project({}, { typescript: TS71 });
    const loaded = loadTypeScript(root, pathToFileURL(join(self, "tsverify.js")));
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toBe("7.1.0-beta");
  });

  it.each(["5.9.3", "6.0.2"])("asks a TypeScript %s project to upgrade", async (version) => {
    const root = await project(fakeTypeScript(version));
    const self = await project({}, { typescript: TS71 });
    // A TypeScript 7 elsewhere is not used for a project that has its own, older one.
    expect(loadTypeScript(root, pathToFileURL(join(self, "tsverify.js")))).toEqual({
      error: `${HEADLINE} This project has TypeScript ${version}: upgrade it with \`npm i -D typescript@latest\`.`,
      projectVersion: version,
    });
  });

  it("reports a TypeScript 7 without the API entry points", async () => {
    const root = await project(fakeTypeScript("7.0.0"));
    expect(loadAlone(root)).toEqual({
      error: `${HEADLINE} This project has TypeScript 7.0.0, which has neither \`typescript/sync\` nor \`typescript/unstable/sync\`: upgrade it with \`npm i -D typescript@latest\`.`,
      projectVersion: "7.0.0",
    });
  });

  it("reports a TypeScript 7 whose API fails to load", async () => {
    const root = await project(
      fakeTypeScript(
        "7.0.0",
        { "./unstable/sync": "./sync.cjs", "./unstable/ast": "./ast.cjs" },
        { "sync.cjs": `throw new Error("no binary");`, "ast.cjs": "module.exports = {};" },
      ),
    );
    expect(loadAlone(root)).toEqual({
      error: `${HEADLINE} This project has TypeScript 7.0.0, which failed to load (no binary): reinstall it with \`npm i -D typescript\`.`,
      projectVersion: "7.0.0",
    });
  });

  it("reports a project without TypeScript", async () => {
    const root = await project({});
    expect(loadAlone(root)).toEqual({
      error: `${HEADLINE} No TypeScript is installed for ${root}: add it with \`npm i -D typescript\`.`,
    });
  });

  it("loads a named TypeScript package (the suite's 7.1 run)", () => {
    const loaded = loadTypeScriptPackage("typescript71", import.meta.url);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.version).toBe("7.1.0-beta");
  });
});

describe("extractor sources", () => {
  it("import TypeScript for types only: the module comes from loadTypeScript", async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const offending: string[] = [];
    for (const file of files) {
      const text = await readFile(join(SRC, file), "utf8");
      const value =
        /^import (?!type )[^;]*from "(typescript(\/[^"]+)?|@typescript\/[^"]+|ts-morph)";/m;
      if (value.test(text)) offending.push(file);
    }
    expect(offending).toEqual([]);
  });
});
