import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findVitest, satisfies, VITEST_MISSING, VITEST_RANGE } from "./vitest-resolve";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tsverify-vitest-")));
  dirs.push(dir);
  return dir;
}

/** A stand-in vitest package under `dir/node_modules/vitest`. */
function fakeVitest(dir: string, version: string, exportsNode = true): string {
  const pkg = join(dir, "node_modules", "vitest");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist", "node.js"), "export const createVitest = () => {};\n");
  const exports: Record<string, string> = { "./package.json": "./package.json" };
  if (exportsNode) exports["./node"] = "./dist/node.js";
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "vitest", version, type: "module", exports }),
  );
  return pkg;
}

/** Where tsverify "is" for the fallback: a module file inside `dir`. */
const selfIn = (dir: string) => pathToFileURL(join(dir, "dist", "tsverify.js")).href;

describe("findVitest", () => {
  it("prefers the project's vitest", () => {
    const project = tempDir();
    const self = tempDir();
    const pkg = fakeVitest(project, "5.1.1");
    fakeVitest(self, "4.1.12");
    expect(findVitest(project, selfIn(self))).toEqual({
      ok: true,
      vitest: { version: "5.1.1", nodeEntry: join(pkg, "dist", "node.js"), from: "project" },
    });
  });

  it("finds the project's vitest from a parent directory (a workspace root)", () => {
    const workspace = tempDir();
    fakeVitest(workspace, "4.1.0");
    const project = join(workspace, "packages", "app");
    mkdirSync(project, { recursive: true });
    const found = findVitest(project, selfIn(tempDir()));
    expect(found.ok && found.vitest).toMatchObject({ version: "4.1.0", from: "project" });
  });

  it("falls back to the vitest next to tsverify", () => {
    const self = tempDir();
    fakeVitest(self, "5.0.0");
    const found = findVitest(tempDir(), selfIn(self));
    expect(found.ok && found.vitest).toMatchObject({ version: "5.0.0", from: "tsverify" });
  });

  it("says how to install vitest when there is none", () => {
    expect(findVitest(tempDir(), selfIn(tempDir()))).toEqual({
      ok: false,
      message: VITEST_MISSING,
    });
    expect(VITEST_MISSING).toBe(
      "tsverify test runs the generated tests with vitest, which isn't installed: npm i -D vitest\n",
    );
  });

  it("rejects a vitest outside the supported range, naming the one found", () => {
    const project = tempDir();
    const pkg = fakeVitest(project, "2.1.9");
    expect(findVitest(project, selfIn(tempDir()))).toEqual({
      ok: false,
      message: `tsverify test needs vitest ${VITEST_RANGE}, but the vitest it found is 2.1.9 (${join(pkg, "package.json")}): npm i -D vitest@5\n`,
    });
    // An in-range version without the `vitest/node` export is just as unusable.
    const broken = tempDir();
    fakeVitest(broken, "5.1.1", false);
    const found = findVitest(broken, selfIn(tempDir()));
    expect(found.ok).toBe(false);
  });
});

describe("satisfies VITEST_RANGE", () => {
  // The versions tried against the orders app (see VITEST_RANGE).
  it.each([
    ["2.1.9", false],
    ["3.0.4", false],
    ["3.0.5", true],
    ["3.2.7", true],
    ["4.0.0", false],
    ["4.0.1", true],
    ["4.1.12", true],
    ["5.0.0", true],
    ["5.1.1", true],
    ["5.2.0-beta.1", true],
    ["6.0.0", false],
    ["not-a-version", false],
  ])("%s → %s", (version, expected) => {
    expect(satisfies(version, VITEST_RANGE)).toBe(expected);
  });
});
