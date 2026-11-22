/**
 * Pack smoke test (`pnpm smoke:pack`): packs the two published packages and installs the tarballs
 * with **npm** into two temporary copies of examples/orders-app outside the workspace:
 *
 * - one with vitest (the CLI's optional peer dependency): every command, including `tsverify
 *   test` and `tsverify view` serving its bundled Mermaid;
 * - one without: everything but `tsverify test` works, which exits 2 and says how to install
 *   vitest. Its `node_modules`, minus the project's own TypeScript, is tsverify's footprint;
 * - one on TypeScript 7, which has no classic compiler API: `check` exits 2 and names
 *   `@typescript/typescript6`, and works once that is installed.
 *
 * Every project has its own TypeScript, an optional peer: tsverify never installs one.
 *
 * Not part of `pnpm test`: the installs need the npm registry for the third-party dependencies.
 *
 *   pnpm smoke:pack [--keep]     --keep leaves the temp directory for inspection
 *
 * Exit 0 when every check passes, 1 otherwise.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { VITEST_MISSING } from "../packages/cli/src/vitest-resolve";
import { findChrome, renderDiagram } from "./browser-render";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const APP = join(REPO, "examples/orders-app");
const PACKAGES = ["runtime", "cli"] as const;
const CLI_MANIFEST = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")) as {
  version: string;
  devDependencies: Record<string, string>;
};
const VERSION = CLI_MANIFEST.version;
/** The vitest the CLI is developed with, installed into the first project. */
const VITEST = CLI_MANIFEST.devDependencies.vitest;
/** Bundled into the CLI, or an optional peer: never installed with it. */
const NOT_INSTALLED = [
  "vitest",
  "mermaid",
  "cac",
  "picocolors",
  "yaml",
  "zod",
  "ts-morph",
  "@ts-morph/common",
];
/** The project's own TypeScript (an optional peer): a classic-API version a typical project has. */
const TYPESCRIPT = "typescript@5.9.3";
/** A TypeScript 7 project, which has no classic compiler API… */
const TYPESCRIPT_7 = "typescript@7.0.2";
/** …and the official package that provides it. */
const TYPESCRIPT_6_API = `@typescript/typescript6@${(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@typescript/typescript6"]}`;
const keep = process.argv.includes("--keep");

// pnpm's lifecycle variables (npm_package_*, npm_config_user_agent, …) must not leak into npm.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toLowerCase().startsWith("npm_") || key.toLowerCase() === "npm_config_registry",
  ),
);
env.NO_COLOR = "1";

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(cmd: string, args: string[], cwd: string): Result {
  const start = performance.now();
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - start };
}

const failures: string[] = [];
const lines: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  lines.push(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
  process.stdout.write(`${lines.at(-1)}\n`);
}

function expectExit(name: string, r: Result, expected: number): void {
  const ok = r.code === expected;
  check(name, ok, `exit ${r.code}, ${seconds(r.ms)}`);
  if (!ok) process.stdout.write(indent(`${r.stdout}\n${r.stderr}`));
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} kB`;
const indent = (s: string) =>
  `${s
    .trim()
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n")}\n`;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const du = (dir: string) => walk(dir).reduce((sum, f) => sum + statSync(f).size, 0);

const tsverify = (args: string[], cwd: string) =>
  run("npx", ["--no", "--", "tsverify", ...args], cwd);

/** Every finding category anywhere in a JSON report. */
function categories(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) categories(v, out);
  else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.category === "string") out.add(record.category);
    for (const v of Object.values(record)) categories(v, out);
  }
  return out;
}

interface FetchedModule {
  path: string;
  status: number;
  bytes: number;
  /** The module is Mermaid's state diagram code. */
  mermaid: boolean;
}

/** `entry` and every module it imports (relative static and dynamic imports), breadth-first. */
async function fetchModuleGraph(entry: URL): Promise<FetchedModule[]> {
  const seen = new Set<string>([entry.href]);
  const queue = [entry];
  const out: FetchedModule[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const res = await fetch(next);
    const code = await res.text();
    out.push({
      path: next.pathname,
      status: res.status,
      bytes: code.length,
      mermaid: code.includes("stateDiagram"),
    });
    for (const m of code.matchAll(/(?:\bfrom|\bimport\(?)\s*"(\.{1,2}\/[^"]+\.js)"/g)) {
      const url = new URL(m[1] as string, next);
      if (!seen.has(url.href)) {
        seen.add(url.href);
        queue.push(url);
      }
    }
  }
  return out;
}

/** `tsverify view --port 0`: waits for the `Local:` URL, fetches the page, then sends SIGINT. */
async function smokeView(cwd: string): Promise<void> {
  // Own process group, so SIGINT reaches npx and tsverify like Ctrl+C in a terminal.
  const child: ChildProcess = spawn(
    "npx",
    ["--no", "--", "tsverify", "view", "--port", "0", "src"],
    {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exited = new Promise<string>((resolve) =>
    child.on("exit", (code, signal) => resolve(signal ?? `exit ${code}`)),
  );
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };

  try {
    const start = performance.now();
    let url: string | undefined;
    while (url === undefined && performance.now() - start < 120_000) {
      url = /Local:\s+(http:\/\/\S+)/.exec(stdout)?.[1];
      if (url === undefined) {
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    check("view --port 0 prints a Local: URL", url !== undefined, url ?? stderr.trim());
    if (url === undefined) return;

    const page = await fetch(new URL("/", url));
    const csp = page.headers.get("content-security-policy") ?? "";
    check(
      "view serves / with a strict CSP",
      page.status === 200 &&
        csp.includes("default-src 'none'") &&
        csp.includes("script-src 'self'"),
      `${page.status}, ${size((await page.text()).length)}`,
    );
    // The app and every chunk it imports, transitively: the bundled Mermaid, all served locally.
    const modules = await fetchModuleGraph(new URL("/app.js", url));
    const failed = modules.filter((m) => m.status !== 200);
    const bytes = modules.reduce((sum, m) => sum + m.bytes, 0);
    check(
      "view serves /app.js and the bundled Mermaid chunks it imports",
      failed.length === 0 && modules.some((m) => m.mermaid) && modules.length > 2,
      `${modules.length} modules, ${size(bytes)}${failed.length > 0 ? `; failed: ${failed.map((m) => `${m.path} ${m.status}`).join(", ")}` : ""}`,
    );
    const vendor = await fetch(new URL("/vendor/mermaid/mermaid.esm.min.mjs", url));
    await vendor.arrayBuffer();
    check("view serves nothing from node_modules", vendor.status === 404, `${vendor.status}`);

    // Served is not drawn: render the page in a real browser when one is available.
    const chrome = findChrome();
    if (chrome === undefined) {
      process.stdout.write(
        "skip  view draws the state diagram in a browser  (no Chrome; set CHROME_PATH)\n",
      );
    } else {
      const drawn = await renderDiagram(chrome, url);
      check(
        "view draws the state diagram in a browser",
        drawn.diagrams.includes("stateDiagram") &&
          !drawn.syntaxError &&
          drawn.nodes > 0 &&
          drawn.errors.length === 0,
        `diagrams: ${drawn.diagrams.join(", ") || "none"}, ${drawn.nodes} nodes${drawn.syntaxError ? ", Mermaid syntax error" : ""}${drawn.errors.length > 0 ? `; errors: ${drawn.errors.join(" | ")}` : ""}`,
      );
    }

    kill("SIGINT");
    const how = await Promise.race([
      exited,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000)),
    ]);
    // npx re-raises the signal, so the group leader ends with SIGINT; tsverify itself says so.
    check(
      "view stops on SIGINT",
      how !== undefined && stderr.includes("tsverify view: stopped"),
      how === undefined
        ? "still running after 15 s"
        : `npx: ${how}; tsverify: "${stderr.trim().split("\n").at(-1)}"`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
  }
}

/** Files of the installed packages that load TypeScript sources or tsx, or embed workspace paths. */
function sourceReferences(dir: string): string[] {
  const patterns: [string, RegExp][] = [
    ["imports tsx", /(?:from|import\(|require\()\s*["'`]tsx(?:\/[^"'`]*)?["'`]/],
    ["imports a .ts module", /(?:from|import\(|require\(|new URL\()\s*["'`][^"'`]*\.ts["'`]/],
    ["embeds the workspace path", new RegExp(REPO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
  ];
  const hits: string[] = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const [what, pattern] of patterns) {
      if (pattern.test(text)) hits.push(`${relative(dir, file)} ${what}`);
    }
    if (file.endsWith("package.json") && /["']\.\/(?:src|bin)\//.test(text)) {
      hits.push(`${relative(dir, file)} points at src/ or bin/`);
    }
  }
  return hits;
}

/** Installed packages under a `node_modules` (`<name>/package.json` and `@scope/<name>/package.json`, nested too). */
const countPackages = (modules: string) =>
  walk(modules).filter((f) =>
    /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+[\\/]package\.json$/.test(f),
  ).length;

/** A plain npm project in `dir`: the clean example app, without workspace dependencies. */
function newProject(dir: string, name: string): void {
  mkdirSync(dir);
  cpSync(join(APP, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(APP, "tsconfig.json"), join(dir, "tsconfig.json"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.tsverify/\n");
}

const tmp = mkdtempSync(join(tmpdir(), "tsverify-smoke-"));
const packs = join(tmp, "packs");
const project = join(tmp, "project");
const bare = join(tmp, "project-without-vitest");
const ts7 = join(tmp, "project-typescript-7");
process.stdout.write(`tsverify pack smoke test (${VERSION}, node ${process.version}) in ${tmp}\n`);

try {
  // 1. Pack (prepack builds) into the temp dir.
  mkdirSync(packs);
  const tarballs: Record<string, string> = {};
  const listings: Record<string, string[]> = {};
  for (const pkg of PACKAGES) {
    const r = run("pnpm", ["pack", "--pack-destination", packs], join(REPO, "packages", pkg));
    expectExit(`pnpm pack @tsverify/${pkg}`, r, 0);
    const file = readdirSync(packs).find((f) => f.startsWith(`tsverify-${pkg}-`));
    if (r.code !== 0 || file === undefined) throw new Error(`packing @tsverify/${pkg} failed`);
    tarballs[pkg] = join(packs, file);
    const listing = run("tar", ["-tzf", tarballs[pkg]], packs).stdout.trim().split("\n");
    listings[pkg] = listing.map((l) => l.replace(/^package\//, ""));
    const chunks = listings[pkg].filter((l) => l.startsWith("dist/viewer/chunks/"));
    const shown = listings[pkg].filter((l) => !l.startsWith("dist/viewer/chunks/"));
    if (chunks.length > 0) shown.push(`dist/viewer/chunks/ (${chunks.length} files)`);
    process.stdout.write(indent(shown.join("\n")));
  }
  const cliFiles = listings.cli ?? [];
  check(
    "the CLI tarball has the bundled viewer and the third-party notices",
    cliFiles.includes("dist/THIRD_PARTY_NOTICES.md") &&
      cliFiles.includes("dist/viewer/app.js") &&
      cliFiles.some((f) => f.startsWith("dist/viewer/chunks/")),
  );

  // 2. A project with tsverify and vitest (an optional peer dependency, needed by `tsverify test`).
  newProject(project, "tsverify-smoke");
  const install = run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      tarballs.cli as string,
      tarballs.runtime as string,
      `vitest@${VITEST}`,
      TYPESCRIPT,
    ],
    project,
  );
  expectExit(`npm install of both tarballs, vitest@${VITEST} and ${TYPESCRIPT}`, install, 0);
  if (install.code !== 0) throw new Error("npm install failed");

  // 3. The installed CLI.
  const version = tsverify(["--version"], project);
  check(
    "--version",
    version.code === 0 && version.stdout.trim() === VERSION,
    version.stdout.trim(),
  );
  const schema = tsverify(["schema"], project);
  let schemaOk = false;
  try {
    schemaOk = typeof JSON.parse(schema.stdout).$schema === "string";
  } catch {}
  check("schema exits 0 with a JSON Schema", schema.code === 0 && schemaOk, `exit ${schema.code}`);

  const git = (args: string[]) => run("git", args, project);
  git(["init", "-q"]);
  git(["add", "-A"]);
  const commit = git([
    "-c",
    "user.name=tsverify smoke",
    "-c",
    "user.email=smoke@tsverify.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);

  expectExit("check src on the clean app", tsverify(["check", "src"], project), 0);

  cpSync(join(APP, "variants/b3-refund-race/src"), join(project, "src"), { recursive: true });
  expectExit("check src with the B3 overlay", tsverify(["check", "src"], project), 1);
  const test = tsverify(["test", "src", "--format", "json"], project);
  let found = new Set<string>();
  try {
    found = categories(JSON.parse(test.stdout));
  } catch {}
  check(
    "test src --format json with B3 has a replay-confirmed finding",
    test.code === 1 && found.has("replay-confirmed"),
    `exit ${test.code}, ${seconds(test.ms)}, categories: ${[...found].sort().join(", ")}`,
  );

  expectExit("diff --base HEAD", tsverify(["diff", "--base", "HEAD"], project), 0);

  await smokeView(project);

  // 4. Nothing installed loads TypeScript sources or tsx.
  const installed = join(project, "node_modules/@tsverify");
  const hits = sourceReferences(installed);
  check("no installed file references tsx, .ts sources or the workspace", hits.length === 0);
  if (hits.length > 0) process.stdout.write(indent(hits.join("\n")));

  // 5. A project without vitest: everything but `tsverify test` works, and that one says why not.
  newProject(bare, "tsverify-smoke-without-vitest");
  const bareInstall = run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      tarballs.cli as string,
      tarballs.runtime as string,
      TYPESCRIPT,
    ],
    bare,
  );
  expectExit(`npm install of both tarballs and ${TYPESCRIPT}, without vitest`, bareInstall, 0);
  if (bareInstall.code !== 0) throw new Error("npm install failed");
  const bareModules = join(bare, "node_modules");
  const unexpected = NOT_INSTALLED.filter((name) =>
    statSync(join(bareModules, name), { throwIfNoEntry: false }),
  );
  check(
    `installs none of ${NOT_INSTALLED.join(", ")}`,
    unexpected.length === 0,
    unexpected.length > 0 ? `installed: ${unexpected.join(", ")}` : "",
  );
  expectExit("without vitest: check src", tsverify(["check", "src"], bare), 0);
  const bareTest = tsverify(["test", "src"], bare);
  check(
    "without vitest: test src exits 2 and says how to install vitest",
    bareTest.code === 2 && bareTest.stderr === VITEST_MISSING && bareTest.stdout === "",
    `exit ${bareTest.code}, stderr: ${JSON.stringify(bareTest.stderr)}`,
  );

  // 6. A TypeScript 7 project: no classic compiler API until @typescript/typescript6 is added.
  newProject(ts7, "tsverify-smoke-typescript-7");
  const ts7Install = run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      tarballs.cli as string,
      tarballs.runtime as string,
      TYPESCRIPT_7,
    ],
    ts7,
  );
  expectExit(`npm install of both tarballs and ${TYPESCRIPT_7}`, ts7Install, 0);
  const ts7Check = tsverify(["check", "src"], ts7);
  check(
    "TypeScript 7 alone: check exits 2 and names @typescript/typescript6",
    ts7Check.code === 2 && ts7Check.stderr.includes("@typescript/typescript6"),
    `exit ${ts7Check.code}, stderr: ${JSON.stringify(ts7Check.stderr.slice(0, 200))}`,
  );
  expectExit(
    `npm install ${TYPESCRIPT_6_API}`,
    run("npm", ["install", "--no-audit", "--no-fund", TYPESCRIPT_6_API], ts7),
    0,
  );
  expectExit(
    "TypeScript 7 + @typescript/typescript6: check src",
    tsverify(["check", "src"], ts7),
    0,
  );

  // 7. Sizes. The project without vitest, minus its own TypeScript, is tsverify's footprint.
  const modules = join(project, "node_modules");
  const withVitest = du(modules);
  const typescriptSize = du(join(bareModules, "typescript"));
  const without = du(bareModules) - typescriptSize;
  process.stdout.write(
    [
      "",
      "sizes and times",
      ...PACKAGES.map(
        (pkg) =>
          `  @tsverify/${pkg} tarball: ${size(statSync(tarballs[pkg] as string).size)}, unpacked ${size(du(join(installed, pkg)))}`,
      ),
      `  tsverify's footprint (node_modules without vitest, minus the project's own ${TYPESCRIPT}, ${size(typescriptSize)}): ${size(without)} (${countPackages(bareModules) - 1} packages), npm install ${seconds(bareInstall.ms)}`,
      `  node_modules with vitest@${VITEST} and ${TYPESCRIPT}: ${size(withVitest)} (${countPackages(modules)} packages), npm install ${seconds(install.ms)}`,
      "",
    ].join("\n"),
  );
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
  process.stdout.write(`FAIL  ${failures.at(-1)}\n`);
} finally {
  if (keep) process.stdout.write(`kept ${tmp}\n`);
  else rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? `smoke:pack passed (${lines.length} checks)\n`
    : `smoke:pack FAILED: ${failures.join("; ")}\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
