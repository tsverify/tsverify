import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BehaviorModel, Finding } from "@tsverify/ir";
import { compareStrings } from "@tsverify/ir";
import { formatFindings } from "@tsverify/render";
import { parseSpec } from "@tsverify/spec";
import { ExitCode, UsageError } from "../exit-codes";
import { GitError, listFiles, repoRoot, resolveCommit, showFile } from "../git";
import { loadSpecs, resolveSpecFiles, toRelative } from "../inputs";
import type { Io } from "../io";
import { type DiffPair, formatDiff, isEnforced, parseDiffFormat } from "../output/diff";
import { terminalFormatter } from "../output/pretty";

export interface DiffCommandOptions {
  /** Raw from cac: the git ref to compare the working tree with. Required. */
  base?: unknown;
  /** Raw from cac; validated by `parseDiffFormat` (default `markdown`). */
  format?: unknown;
  /** Keep only specs that are `enforced: true` on either side. */
  enforcedOnly?: unknown;
}

/** Directories `findSpecFiles` skips on the head side; skipped on the base side too. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".tsv", "dist"]);
const SPEC_SUFFIX = ".behavior.yaml";

/**
 * `tsv diff --base <ref> [paths…]`: the behavior diff between the specs at `<ref>` and the
 * working tree. Head specs are found like `check` finds them; base specs are the same paths at
 * `<ref>`, read with the local `git` (`ls-tree`, `show`) and parsed from text. Files are paired by
 * path, so a renamed file is one removed and one added behavior.
 *
 * Exit 0 whenever the diff could be computed, changed or not (CI decides what a change means);
 * 2 when a spec on either side is invalid (findings on stderr), the ref is unknown, or the cwd
 * is not in a git repository.
 */
export async function diffCommand(
  io: Io,
  paths: readonly string[],
  options: DiffCommandOptions,
): Promise<ExitCode> {
  const format = parseDiffFormat(options.format ?? "markdown");
  const ref = parseBase(options.base);
  try {
    return await diff(io, paths, ref, format, options.enforcedOnly === true);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    io.stderr(`error: ${e.message}\n`);
    return ExitCode.InvalidInput;
  }
}

async function diff(
  io: Io,
  paths: readonly string[],
  ref: string,
  format: ReturnType<typeof parseDiffFormat>,
  enforcedOnly: boolean,
): Promise<ExitCode> {
  const root = await repoRoot(io.cwd);
  const commit = await resolveCommit(root, ref);
  // git reports the root with symlinks resolved; so must the cwd be, for relative paths to agree.
  const cwd = await realpath(io.cwd);
  const args = paths.length > 0 ? paths : ["."];

  const pathspecs = args.map((p) => {
    const rel = toRelative(root, resolve(cwd, p));
    if (rel === ".." || rel.startsWith("../")) {
      throw new UsageError(`${p} is outside the git repository (${root})`);
    }
    return rel === "" ? "." : rel;
  });
  const named = new Set(pathspecs);
  const baseFiles = (await listFiles(root, commit, pathspecs))
    .filter((f) => named.has(f) || (f.endsWith(SPEC_SUFFIX) && !inSkippedDir(f)))
    .map((f) => toRelative(cwd, join(root, f)));
  const headFiles = await resolveSpecFiles(args, cwd, { existingOnly: true });

  const files = [...new Set([...baseFiles, ...headFiles])].sort(compareStrings);
  if (files.length === 0) {
    throw new UsageError(`no *.behavior.yaml files in ${args.join(", ")} (working tree or ${ref})`);
  }

  const errors: Finding[] = [];
  const head = new Map<string, BehaviorModel>();
  for (const spec of await loadSpecs(headFiles, cwd)) {
    errors.push(...spec.findings.filter((f) => f.severity === "error"));
    if (spec.model) head.set(spec.file, spec.model);
  }
  const base = new Map<string, BehaviorModel>();
  for (const file of new Set(baseFiles)) {
    const repoPath = toRelative(root, resolve(cwd, file));
    const { model, findings } = parseSpec(await showFile(root, commit, repoPath), file);
    errors.push(...findings.filter((f) => f.severity === "error").map((f) => atRef(f, ref)));
    if (model) base.set(file, model);
  }
  if (errors.length > 0) {
    io.stderr(formatFindings(errors, { cwd, formatter: terminalFormatter(io) }));
    return ExitCode.InvalidInput;
  }

  const all: DiffPair[] = files.map((file) => ({
    file,
    ...(base.has(file) && { base: base.get(file) }),
    ...(head.has(file) && { head: head.get(file) }),
  }));
  const pairs = enforcedOnly ? all.filter(isEnforced) : all;
  const run = {
    base: { ref, commit },
    pairs,
    ...(enforcedOnly && { enforcedOnly: { skipped: all.length - pairs.length } }),
  };
  io.stdout(formatDiff(run, format, io));
  return ExitCode.Ok;
}

function parseBase(value: unknown): string {
  if (value === undefined || value === true) {
    throw new UsageError("--base <git-ref> is required (e.g. --base origin/main)");
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new UsageError(`--base takes one git ref (got ${String(value)})`);
  }
  return String(value);
}

function inSkippedDir(file: string): boolean {
  return file
    .split("/")
    .slice(0, -1)
    .some((dir) => SKIPPED_DIRS.has(dir));
}

/** A base-side finding, located as `<ref>:<file>` so it is not mistaken for the working tree. */
function atRef(f: Finding, ref: string): Finding {
  if (f.specAt === undefined) return f;
  return { ...f, specAt: { ...f.specAt, file: `${ref}:${f.specAt.file}` } };
}
