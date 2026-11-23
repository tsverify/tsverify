import type { StorageArg, StorageBinding, StorageFunction, StorageRole } from "./model";
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

/** Where a role is: the positional argument, and the field path inside it (`[]`: the argument). */
export interface StorageRoleAt {
  index: number;
  path: string[];
}

function findRole(arg: StorageArg, role: StorageRole, path: string[]): string[] | undefined {
  if (typeof arg === "string") return arg === role ? path : undefined;
  for (const [field, inner] of Object.entries(arg)) {
    const found = findRole(inner, role, [...path, field]);
    if (found) return found;
  }
  return undefined;
}

/** Where `role` is in a storage function's arguments (the first place), if anywhere. */
export function storageRoleAt(
  fn: Pick<StorageFunction, "args">,
  role: StorageRole,
): StorageRoleAt | undefined {
  for (const [index, arg] of fn.args.entries()) {
    const path = findRole(arg, role, []);
    if (path) return { index, path };
  }
  return undefined;
}

/** Every role a storage function's arguments carry, positional and field roles, in order. */
export function storageRoles(fn: Pick<StorageFunction, "args">): StorageRole[] {
  const out: StorageRole[] = [];
  const visit = (arg: StorageArg) => {
    if (typeof arg === "string") out.push(arg);
    else for (const inner of Object.values(arg)) visit(inner);
  };
  for (const arg of fn.args) visit(arg);
  return out;
}

/** One argument as the spec writes it: `key`, `{ id: key }`, `{ where: { id: key } }`. */
export function formatStorageArg(arg: StorageArg): string {
  if (typeof arg === "string") return arg;
  const fields = Object.entries(arg).map(
    ([field, inner]) => `${field}: ${formatStorageArg(inner)}`,
  );
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
}

/**
 * `path#symbol`, plus what differs from the defaults: `(roles)` when the roles are not the
 * default ones, then ` from [a, b]`, ` to s` and ` returns r` (any `returns` but `changed`).
 * E.g. `src/repo.ts#markPaid(key, _) from [pending] to paid returns count`.
 */
export function formatStorageFunction(kind: StorageKind, fn: StorageFunction): string {
  let text = formatSymbolRef(fn.ref);
  const defaults = defaultStorageArgs(kind, fn);
  const args = fn.args.map(formatStorageArg);
  if (args.join(",") !== defaults.join(",")) text += `(${args.join(", ")})`;
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
