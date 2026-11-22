/**
 * Pack smoke test (`pnpm smoke:pack`): packs the two published packages, installs the tarballs
 * with **npm** into a temporary copy of examples/orders-app outside the workspace, and runs the
 * installed `tsverify` there. Not part of `pnpm test`: the install needs the npm registry for the
 * third-party dependencies.
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

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const APP = join(REPO, "examples/orders-app");
const PACKAGES = ["runtime", "cli"] as const;
const VERSION = (
  JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")) as { version: string }
).version;
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

    for (const path of ["/", "/app.js", "/vendor/mermaid/mermaid.esm.min.mjs"]) {
      const res = await fetch(new URL(path, url));
      const body = await res.text();
      check(`view serves ${path}`, res.status === 200, `${res.status}, ${size(body.length)}`);
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

const tmp = mkdtempSync(join(tmpdir(), "tsverify-smoke-"));
const packs = join(tmp, "packs");
const project = join(tmp, "project");
process.stdout.write(`tsverify pack smoke test (${VERSION}, node ${process.version}) in ${tmp}\n`);

try {
  // 1. Pack (prepack builds) into the temp dir.
  mkdirSync(packs);
  const tarballs: Record<string, string> = {};
  for (const pkg of PACKAGES) {
    const r = run("pnpm", ["pack", "--pack-destination", packs], join(REPO, "packages", pkg));
    expectExit(`pnpm pack @tsverify/${pkg}`, r, 0);
    const file = readdirSync(packs).find((f) => f.startsWith(`tsverify-${pkg}-`));
    if (r.code !== 0 || file === undefined) throw new Error(`packing @tsverify/${pkg} failed`);
    tarballs[pkg] = join(packs, file);
    const listing = run("tar", ["-tzf", tarballs[pkg]], packs).stdout.trim().split("\n");
    process.stdout.write(indent(listing.map((l) => l.replace(/^package\//, "")).join("\n")));
  }

  // 2. A plain npm project: the example app without workspace dependencies.
  mkdirSync(project);
  cpSync(join(APP, "src"), join(project, "src"), { recursive: true });
  cpSync(join(APP, "tsconfig.json"), join(project, "tsconfig.json"));
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "tsverify-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(project, ".gitignore"), "node_modules/\n.tsverify/\n");
  const install = run(
    "npm",
    ["install", "--no-audit", "--no-fund", tarballs.cli as string, tarballs.runtime as string],
    project,
  );
  expectExit("npm install of both tarballs", install, 0);
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

  const modules = join(project, "node_modules");
  const packageCount = walk(modules).filter((f) =>
    /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+[\\/]package\.json$/.test(f),
  ).length;
  process.stdout.write(
    [
      "",
      "sizes and times",
      ...PACKAGES.map(
        (pkg) =>
          `  @tsverify/${pkg} tarball: ${size(statSync(tarballs[pkg] as string).size)}, unpacked ${size(du(join(installed, pkg)))}`,
      ),
      `  npm install: ${seconds(install.ms)}, node_modules ${size(du(modules))} (${packageCount} packages)`,
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
