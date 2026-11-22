import { stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { BehaviorModel, Finding } from "@tsverify/ir";
import { compareStrings } from "@tsverify/ir";
import { findSpecFiles, loadSpec } from "@tsverify/spec";
import { UsageError } from "./exit-codes";

export interface LoadedSpec {
  /** Relative to the cwd, with `/` separators. */
  file: string;
  /** Absent when the spec has errors. */
  model?: BehaviorModel;
  /** The behavior name, when the file got far enough to declare one. */
  behavior?: string;
  findings: Finding[];
}

/**
 * Spec files named by `paths` (default: the cwd). Directories are searched for
 * `**\/*.behavior.yaml`; files are taken as given, so a missing file surfaces as an
 * `invalid-spec` finding from `loadSpec`. Deduplicated, sorted, relative to `cwd`.
 *
 * `existingOnly` (`tsverify diff`, where the other side may have the files): a missing path and a
 * directory without specs contribute nothing instead of an error.
 */
export async function resolveSpecFiles(
  paths: readonly string[],
  cwd: string,
  options: { existingOnly?: boolean } = {},
): Promise<string[]> {
  const files = new Set<string>();
  for (const path of paths.length > 0 ? paths : ["."]) {
    const absolute = resolve(cwd, path);
    if (!(await isDirectory(absolute))) {
      if (!options.existingOnly || (await exists(absolute))) files.add(toRelative(cwd, absolute));
      continue;
    }
    const found = await findSpecFiles(absolute);
    if (found.length === 0 && !options.existingOnly) {
      throw new UsageError(`no *.behavior.yaml files found in ${path}`);
    }
    for (const file of found) files.add(toRelative(cwd, join(absolute, file)));
  }
  return [...files].sort(compareStrings);
}

/** Loads each file (relative to `cwd`) in order. Never throws for bad input. */
export async function loadSpecs(files: readonly string[], cwd: string): Promise<LoadedSpec[]> {
  const out: LoadedSpec[] = [];
  for (const file of files) {
    const { model, findings } = await loadSpec(file, { root: cwd });
    const behavior = model?.name ?? findings.find((f) => f.behavior !== undefined)?.behavior;
    out.push({ file, model, behavior, findings });
  }
  return out;
}

/**
 * `--enforced-only`: the specs with `enforced: true`, plus every spec that failed to parse. An
 * invalid spec may well be an enforced one, so breaking it must not take it out of a blocking run.
 */
export function selectEnforced(specs: readonly LoadedSpec[]): {
  kept: LoadedSpec[];
  skipped: number;
} {
  const kept = specs.filter((s) => s.model === undefined || s.model.enforced === true);
  return { kept, skipped: specs.length - kept.length };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `absolute` relative to `cwd`, with `/` separators. */
export function toRelative(cwd: string, absolute: string): string {
  return relative(cwd, absolute).split(sep).join("/");
}
