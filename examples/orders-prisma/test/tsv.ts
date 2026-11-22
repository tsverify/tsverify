/**
 * Runs the real `tsv` pipeline on a materialized copy of the Prisma app: `tsv check` in-process
 * through `@tsv/cli`'s `main(argv, io)`, and `tsv test` as a subprocess (it runs vitest itself, so
 * it is not nested in this vitest), like packages/cli/test/e2e does for the assign app.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Io, main } from "@tsv/cli";
import type { Finding } from "@tsv/ir";
import { materialize } from "./materialize";

const BIN = fileURLToPath(new URL("../../../packages/cli/bin/tsv.js", import.meta.url));
const ASSIGN_GOLDENS = new URL("../../../packages/cli/test/e2e/__golden__/", import.meta.url);

/** The part of `tsv … --format json` the suites read. */
export interface Report {
  findings: Finding[];
  specs: {
    file: string;
    project?: string | null;
    generated?: { dir: string; tests: { total: number; passed: number; failed: number } };
  }[];
  summary: { errors: number; warnings: number };
}

export interface Run {
  code: number;
  report: Report;
  stderr: string;
  durationMs: number;
}

function now(): number {
  return globalThis.performance.now();
}

/** `tsv check src --format json` in the materialized app (clean when `variant` is undefined). */
export async function tsvCheck(variant: string | undefined): Promise<Run> {
  const app = await materialize(variant);
  try {
    const out = { stdout: "", stderr: "" };
    const io: Io = {
      stdout: (s) => {
        out.stdout += s;
      },
      stderr: (s) => {
        out.stderr += s;
      },
      cwd: app.root,
      isTTY: false,
      env: {},
    };
    const start = now();
    const code = await main(["check", "src", "--format", "json"], io);
    const durationMs = now() - start;
    return { code, report: JSON.parse(out.stdout) as Report, stderr: out.stderr, durationMs };
  } finally {
    await app.dispose();
  }
}

/** `tsv test src --format json` in the materialized app, as a subprocess. */
export async function tsvTest(variant: string | undefined): Promise<Run> {
  const app = await materialize(variant);
  try {
    const start = now();
    const result = await promisify(execFile)(
      process.execPath,
      [BIN, "test", "src", "--format", "json"],
      { cwd: app.root, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined } },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
    const durationMs = now() - start;
    return {
      code: result.code,
      report: JSON.parse(result.stdout) as Report,
      stderr: result.stderr,
      durationMs,
    };
  } finally {
    await app.dispose();
  }
}

/** `severity id` of every finding the assign app's `tsv check` golden has for a variant. */
export async function assignCheckFindings(variant: string): Promise<string[]> {
  const golden = await readFile(new URL(`${variant}.json`, ASSIGN_GOLDENS), "utf8");
  return (JSON.parse(golden) as Report).findings.map((f) => `${f.severity} ${f.id}`);
}

/** `category id` of every error and warning, in output order. */
export function problems(report: Report): string[] {
  return report.findings.filter((f) => f.severity !== "info").map((f) => `${f.category} ${f.id}`);
}
