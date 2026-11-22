import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildViewData,
  DEFAULT_HOST,
  isLoopback,
  openBrowser,
  type SpecInput,
  startViewer,
  type ViewData,
  type ViewerUrls,
} from "@tsv/viewer";
import { ExitCode, UsageError } from "../exit-codes";
import type { Io } from "../io";
import { rebaseLocations } from "../locations";
import { type CheckCommandOptions, runCheck } from "./check";

export interface ViewCommandOptions extends Omit<CheckCommandOptions, "format"> {
  /** Raw from cac: 0 (the default) picks a free port. */
  port?: unknown;
  host?: unknown;
  /** `--allow-host`: one name or several (cac gives an array for a repeated flag). */
  allowHost?: unknown;
  /** Open the page in the default browser. Never the default. */
  open?: unknown;
}

/**
 * `tsv view [paths…]`: runs the `tsv check` pipeline (same options) and serves the result in a
 * local browser viewer (`@tsv/viewer`), rebuilding whenever a spec or its project's `src/`
 * changes. Prints the URL and runs until interrupted (`Io.onInterrupt`), then exits 0. Bad
 * options, paths without specs, or a port that cannot be bound are usage errors (exit 2).
 */
export async function viewCommand(
  io: Io,
  paths: readonly string[],
  options: ViewCommandOptions,
): Promise<ExitCode> {
  const port = parsePort(options.port);
  const host = parseHost(options.host);
  const allowHosts = parseAllowHosts(options.allowHost);
  const load = () => loadViewData(io.cwd, paths, options);

  const viewer = await startViewer({
    load,
    watch: (data) => watchList(data),
    port,
    host,
    allowHosts,
    onReload: (e) => {
      io.stderr(
        e.error === undefined
          ? `tsv view: rebuilt (build ${e.version}, ${e.ms} ms)\n`
          : `tsv view: rebuild failed, still serving the previous build: ${e.error}\n`,
      );
    },
  }).catch((e: unknown) => {
    const code = (e as { code?: unknown }).code;
    if (code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL") {
      throw new UsageError(`cannot listen on ${host}:${port} (${code})`);
    }
    throw e;
  });

  io.stdout(formatUrls(viewer.urls));
  if (!isLoopback(host)) {
    io.stderr(
      `warning: listening on ${host}, so other machines may reach this viewer and read your specs and code locations\n`,
    );
  }
  io.stderr("Watching for changes. Press Ctrl+C to stop.\n");
  if (options.open === true) {
    openBrowser(viewer.url, {
      onError: (e) => io.stderr(`tsv view: could not open a browser (${e.message})\n`),
    });
  }

  await new Promise<void>((stop) => {
    const off = io.onInterrupt?.(() => {
      off?.();
      stop();
    });
  });
  await viewer.close();
  io.stderr("tsv view: stopped\n");
  return ExitCode.Ok;
}

/**
 * The `tsv check` pipeline as `ViewData`: every location relative to the cwd (the code model is
 * rebased from its project root).
 */
export async function loadViewData(
  cwd: string,
  paths: readonly string[],
  options: Omit<CheckCommandOptions, "format">,
): Promise<ViewData> {
  const run = await runCheck(cwd, paths, options);
  const specs = run.specs.map((loaded, i): SpecInput => {
    const report = run.report.specs[i];
    const outcome = run.code?.[i];
    const input: SpecInput = {
      file: loaded.file,
      project: report?.project ?? null,
      findings: report?.findings ?? [],
    };
    if (loaded.behavior !== undefined) input.behavior = loaded.behavior;
    if (loaded.model) input.spec = loaded.model;
    if (outcome?.code && outcome.root)
      input.code = rebaseLocations(outcome.code, outcome.root, cwd);
    return input;
  });
  return buildViewData({ cwd, specOnly: run.report.specOnly === true, specs });
}

/** Each spec file, plus each project's `src/` (or the project root when it has none). */
export function watchList(data: ViewData): string[] {
  const out = new Set<string>();
  for (const spec of data.specs) {
    out.add(resolve(data.cwd, spec.file));
    if (spec.project === null) continue;
    const root = resolve(data.cwd, spec.project);
    const src = resolve(root, "src");
    out.add(existsSync(src) ? src : root);
  }
  return [...out];
}

function parsePort(value: unknown): number {
  if (value === undefined) return 0;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UsageError(`--port must be an integer from 0 to 65535 (got ${String(value)})`);
  }
  return n;
}

/** Next/Vite-style URL block: `Local`, then `Network` (or how to expose / forward). */
export function formatUrls(urls: ViewerUrls): string {
  const lines = ["tsv view"];
  if (urls.local) lines.push(`  Local:    ${urls.local}`);
  if (urls.network.length === 0) {
    lines.push(
      "  Network:  not exposed (use --host 0.0.0.0, or forward the port: see docs/viewer.md)",
    );
  }
  urls.network.forEach((u, i) => {
    lines.push(`  ${i === 0 ? "Network: " : "         "} ${u}`);
  });
  return `${lines.join("\n")}\n`;
}

function parseAllowHosts(value: unknown): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((v) => {
    if (typeof v !== "string" || !/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/i.test(v.trim())) {
      throw new UsageError(`--allow-host takes a host name without a port (got ${String(v)})`);
    }
    return [v.trim()];
  });
}

function parseHost(value: unknown): string {
  if (value === undefined) return DEFAULT_HOST;
  if (typeof value !== "string" || value === "") {
    throw new UsageError(`--host takes one address (got ${String(value)})`);
  }
  return value;
}
