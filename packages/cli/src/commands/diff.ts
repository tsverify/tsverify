import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".tsverify", "dist"]);
const SPEC_SUFFIX = ".behavior.yaml";

/**
 * `tsverify diff --base <ref> [paths…]`: the behavior diff between the specs at `<ref>` and the
 * working tree. Head specs are found like `check` finds them; base specs are the same paths at
 * `<ref>`, read with the local `git` (`ls-tree`, `show`) and parsed from text. Files are paired by
 * path, so a renamed file is one removed and one added behavior. Each path is read from the git
 * repository that contains it, not the cwd's: `tsverify diff --base HEAD ../other/x.behavior.yaml`
 * compares with `HEAD` of `../other`'s repository (paths in several repositories: `<ref>` in each).
 *
 * Exit 0 whenever the diff could be computed, changed or not (CI decides what a change means);
 * 2 when a spec on either side is invalid (findings on stderr), the ref is unknown, or a path is
 * not in a git repository.
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
  // git reports a root with symlinks resolved; so must the cwd be, for relative paths to agree.
  const cwd = await realpath(io.cwd);
  const args = paths.length > 0 ? paths : ["."];

  // Each path's own repository, and the pathspecs to list in it.
  const repos = new Map<string, { commit: string; pathspecs: string[] }>();
  for (const p of args) {
    const absolute = await realPath(resolve(cwd, p));
    const root = await repoRoot(await existingDir(absolute));
    let entry = repos.get(root);
    if (entry === undefined) {
      entry = { commit: await resolveCommit(root, ref), pathspecs: [] };
      repos.set(root, entry);
    }
    const rel = toRelative(root, absolute);
    entry.pathspecs.push(rel === "" ? "." : rel);
  }
  // Base-side file (relative to the cwd) → where to read it.
  const baseAt = new Map<string, { root: string; commit: string }>();
  for (const [root, { commit, pathspecs }] of repos) {
    const named = new Set(pathspecs);
    for (const f of await listFiles(root, commit, pathspecs)) {
      if (!named.has(f) && !(f.endsWith(SPEC_SUFFIX) && !inSkippedDir(f))) continue;
      baseAt.set(toRelative(cwd, join(root, f)), { root, commit });
    }
  }
  const baseFiles = [...baseAt.keys()];
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
  for (const file of baseFiles) {
    const { root, commit } = baseAt.get(file) as { root: string; commit: string };
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
  const [first] = repos.values();
  const commits = new Map(
    [...repos].map(([root, { commit }]) => [toRelative(cwd, root) || ".", commit]),
  );
  const run = {
    base: {
      ref,
      commit: first?.commit ?? "",
      ...(repos.size > 1 ? { commits: Object.fromEntries(commits) } : {}),
    },
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

/**
 * `path` with symlinks resolved (as git reports a repository root), also when it doesn't exist
 * (a spec deleted from the working tree): its nearest existing ancestor resolved, the rest kept.
 */
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPath(parent), basename(path));
  }
}

/** The nearest existing directory at or above `path` (a file's own directory), to run git in. */
async function existingDir(path: string): Promise<string> {
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      const stats = await stat(dir);
      return stats.isDirectory() ? dir : dirname(dir);
    } catch {
      if (dirname(dir) === dir) return dir;
    }
  }
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
