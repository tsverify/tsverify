import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface WatchOptions {
  /** Quiet period after the last change before `onChange` fires (default 150 ms). */
  debounceMs?: number;
  /** Poll every `pollMs` instead of using `fs.watch` (also the fallback when it fails). */
  poll?: boolean;
  /** Polling interval (default 1000 ms). */
  pollMs?: number;
}

export interface Watcher {
  close(): void;
}

/** Directory names never worth a rebuild. */
const IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".tsv"]);

/**
 * Watches files and directories (directories recursively) and calls `onChange` once per burst of
 * changes. A file is watched through its directory, so editors that save by renaming a new file
 * over the old one keep triggering. Changes under `node_modules`, `.git` and `.tsv` are ignored.
 * Paths that do not exist are skipped. Uses `fs.watch`; falls back to polling a path whose
 * watcher cannot be created or fails.
 */
export function watchPaths(
  paths: readonly string[],
  onChange: () => void,
  options: WatchOptions = {},
): Watcher {
  const debounceMs = options.debounceMs ?? 150;
  const pollMs = options.pollMs ?? 1000;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const fire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, debounceMs);
  };

  const watchers: FSWatcher[] = [];
  const polls: NodeJS.Timeout[] = [];
  const startPolling = (target: Target) => {
    let last = signature(target);
    const interval = setInterval(() => {
      const now = signature(target);
      if (now !== last) {
        last = now;
        fire();
      }
    }, pollMs);
    interval.unref();
    polls.push(interval);
  };

  for (const target of targets(paths)) {
    if (options.poll) {
      startPolling(target);
      continue;
    }
    try {
      const w = watch(target.dir, { recursive: target.recursive }, (_event, filename) => {
        if (relevant(target, filename === null ? undefined : String(filename))) fire();
      });
      w.on("error", () => {
        w.close();
        if (!closed) startPolling(target);
      });
      watchers.push(w);
    } catch {
      startPolling(target);
    }
  }

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const p of polls) clearInterval(p);
    },
  };
}

interface Target {
  dir: string;
  recursive: boolean;
  /** Basenames to react to (watched files); undefined = everything under `dir`. */
  only?: Set<string>;
}

/** Existing directories to watch, merged: a file's directory, or a directory itself. */
function targets(paths: readonly string[]): Target[] {
  const byDir = new Map<string, Target>();
  for (const p of paths) {
    const absolute = resolve(p);
    const kind = kindOf(absolute);
    if (kind === undefined) continue;
    const dir = kind === "dir" ? absolute : dirname(absolute);
    const existing = byDir.get(dir);
    if (kind === "dir") {
      byDir.set(dir, { dir, recursive: true });
    } else if (!existing) {
      byDir.set(dir, { dir, recursive: false, only: new Set([basename(absolute)]) });
    } else {
      existing.only?.add(basename(absolute));
    }
  }
  // Drop targets inside a recursively watched directory.
  const recursive = [...byDir.values()].filter((t) => t.recursive).map((t) => t.dir);
  return [...byDir.values()].filter(
    (t) => !recursive.some((r) => r !== t.dir && t.dir.startsWith(r + sep)),
  );
}

function relevant(target: Target, filename: string | undefined): boolean {
  if (filename === undefined) return true;
  const parts = filename.split(/[\\/]/);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return false;
  return target.only === undefined || target.only.has(parts.at(-1) ?? "");
}

function kindOf(path: string): "dir" | "file" | undefined {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

/** Names, sizes and mtimes of everything the target covers, for polling. */
function signature(target: Target): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name)) continue;
      if (depth === 0 && target.only && !target.only.has(name)) continue;
      const path = join(dir, name);
      try {
        const s = statSync(path);
        out.push(`${path}:${s.size}:${s.mtimeMs}`);
        if (s.isDirectory() && target.recursive) walk(path, depth + 1);
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  walk(target.dir, 0);
  return out.join("\n");
}
