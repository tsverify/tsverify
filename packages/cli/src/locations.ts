import { relative, resolve, sep } from "node:path";
import type { SourceLocation } from "@tsverify/ir";

/**
 * A copy of `value` in which every `SourceLocation.file` (relative to the directory `from`) is
 * re-expressed relative to the directory `to`, with `/` separators. Nothing is mutated: objects
 * and arrays on the way are copied, so models and findings shared with other code stay intact.
 *
 * Locations are recognised by shape (`file` string, `line` and `column` numbers), which covers
 * every `SourceLocation` in `@tsverify/ir` (finding `specAt` / `codeAt`, model `at`, `sites.*`) and
 * leaves `SymbolRef`-like `{ file, symbol }` paths, which are project-relative by contract, alone.
 *
 * The extractor and conformance report locations relative to the project root while the CLI
 * reports everything relative to the cwd: this is presentation, so the CLI does it.
 */
export function rebaseLocations<T>(value: T, from: string, to: string): T {
  if (resolve(from) === resolve(to)) return value;
  return rebase(value, (file) => rebaseFile(file, from, to)) as T;
}

/** `file` (relative to `from`, or absolute) as a `/`-separated path relative to `to`. */
export function rebaseFile(file: string, from: string, to: string): string {
  return relative(to, resolve(from, file)).split(sep).join("/") || ".";
}

function rebase(value: unknown, map: (file: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => rebase(v, map));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = rebase(v, map);
  if (isLocation(value)) out.file = map(value.file);
  return out;
}

function isLocation(value: object): value is SourceLocation {
  const v = value as Partial<Record<keyof SourceLocation, unknown>>;
  return typeof v.file === "string" && typeof v.line === "number" && typeof v.column === "number";
}
