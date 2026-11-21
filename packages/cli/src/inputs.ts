import { stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { BehaviorModel, Finding } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";
import { findSpecFiles, loadSpec } from "@tsv/spec";
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
 */
export async function resolveSpecFiles(paths: readonly string[], cwd: string): Promise<string[]> {
  const files = new Set<string>();
  for (const path of paths.length > 0 ? paths : ["."]) {
    const absolute = resolve(cwd, path);
    if (!(await isDirectory(absolute))) {
      files.add(toRelative(cwd, absolute));
      continue;
    }
    const found = await findSpecFiles(absolute);
    if (found.length === 0) throw new UsageError(`no *.behavior.yaml files found in ${path}`);
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function toRelative(cwd: string, absolute: string): string {
  return relative(cwd, absolute).split(sep).join("/");
}
