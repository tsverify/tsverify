import type { StorageBinding, StorageFunction, StorageRole } from "./model";
import { formatSymbolRef } from "./refs";

/** The four kinds of storage function in `bindings.storage`, in YAML order. */
export const STORAGE_KINDS = ["read", "save", "update", "atomic"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

export const STORAGE_ROLES: readonly StorageRole[] = [
  "key",
  "entity",
  "patch",
  "from",
  "to",
  "callback",
  "_",
];

/**
 * The argument roles a storage function has when the spec gives none: read `[key]`, save
 * `[entity]`, update `[key, from, to]` without the roles its fixed `from` / `to` replace, atomic
 * `[callback]`.
 */
export function defaultStorageArgs(
  kind: StorageKind,
  fixed: Pick<StorageFunction, "from" | "to"> = {},
): StorageRole[] {
  switch (kind) {
    case "read":
      return ["key"];
    case "save":
      return ["entity"];
    case "update":
      return [
        "key",
        ...(fixed.from === undefined ? (["from"] as const) : []),
        ...(fixed.to === undefined ? (["to"] as const) : []),
      ];
    case "atomic":
      return ["callback"];
  }
}

/**
 * `path#symbol`, plus what differs from the defaults: `(roles)` when the roles are not the
 * default ones, then ` from [a, b]`, ` to s` and ` returns r` (any `returns` but `changed`).
 * E.g. `src/repo.ts#markPaid(key, _) from [pending] to paid returns count`.
 */
export function formatStorageFunction(kind: StorageKind, fn: StorageFunction): string {
  let text = formatSymbolRef(fn.ref);
  const defaults = defaultStorageArgs(kind, fn);
  if (fn.args.join(",") !== defaults.join(",")) text += `(${fn.args.join(", ")})`;
  if (fn.from !== undefined) text += ` from [${fn.from.join(", ")}]`;
  if (fn.to !== undefined) text += ` to ${fn.to}`;
  if (fn.returns !== undefined && fn.returns !== "changed") text += ` returns ${fn.returns}`;
  return text;
}

/** Every storage function of the binding with its kind, in kind order then YAML order. */
export function storageFunctions(
  binding: StorageBinding,
): { kind: StorageKind; fn: StorageFunction }[] {
  return STORAGE_KINDS.flatMap((kind) => binding[kind].map((fn) => ({ kind, fn })));
}
