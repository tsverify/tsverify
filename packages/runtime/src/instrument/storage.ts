/**
 * `instrument.storage`: an in-memory stand-in for the app's own storage functions, named in the
 * spec's `bindings.storage` (`ir.StorageBinding`). The generated test mocks each function's module
 * and exports `fake.functions[symbol]` in place of the real function, so the app's code runs
 * unchanged against one in-memory table of the entity, keyed by `binding.key`.
 *
 * Each function honours its argument roles (`key`, `entity`, `patch`, `from`, `to`, `callback`,
 * `_`; positional, or, for an argument that is an object of named arguments, by field:
 * `args: [{ id: key }]` takes the key from `findOrder({ tx, id })`'s `id`):
 *
 * | Kind     | Does                                                                              |
 * |----------|-----------------------------------------------------------------------------------|
 * | `read`   | returns a copy of the entity with that key, or what `missing` says                |
 * | `save`   | stores a copy of `entity` (under `key` when given, else its key field), or merges `patch` into the entity with that `key` |
 * | `update` | when the stored state is one of the from-states (the `from` argument, or the fixed `from`), sets `to` (the argument or the fixed state) and merges `patch`; returns per `returns` |
 * | `atomic` | runs `callback` under one lock shared by every atomic function, passing it one argument: a stand-in transaction (`standInTransaction`) |
 *
 * `update` returns, on success / when the state check fails (or the key is missing):
 * `changed` (default) `true` / `false`; `count` `1` / `0`; `entity` a copy of the updated entity /
 * `undefined`; `throws` `undefined` / throws `StorageConditionError`.
 *
 * Replay semantics, as in `instrument.store`:
 * - `read`, `save` and `update` are **sync** gates labelled `storage.<symbol>` (`CallSite.gate`).
 *   The work happens when the gate is passed, so `update` is one compare-and-set step.
 * - Copy on read and copy on write (`structuredClone`).
 * - An `atomic` function is a **transparent** gate `storage.<symbol>` that behaves as a
 *   transaction: passing it requests one serialized mutex per fake (a worker that finds it held
 *   becomes `waiting`), and inside the callback reads see the callback's own staged writes, which
 *   are applied when it resolves and dropped when it throws. A nested atomic call runs inline,
 *   inside the outer one.
 *
 * The callback's argument: the real function passes its callback a transaction (or a lock
 * handle), which the code under test hands on to the storage functions and clients it calls
 * (`withTransaction(ctx, async (tx) => { await findOrder(tx, id); … })`). Those are faked and
 * ignore it (a `_` argument), so the fake passes a stand-in: any use of the stand-in itself (a
 * property read, a call) throws a `StandInTransactionError` naming what was used, since only code
 * the spec doesn't bind uses it, and that code would otherwise reach the real database.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { preview } from "../preview.js";
import type { Scheduler } from "../scheduler.js";
import type { Row } from "./store.js";

/** `ir.StorageRole`. */
export type StorageRoleInput = "key" | "entity" | "patch" | "from" | "to" | "callback" | "_";

/** `ir.StorageArg`: a role, or the roles of an object argument's fields, by name. */
export type StorageArgInput = StorageRoleInput | { readonly [field: string]: StorageArgInput };

/** `ir.StorageFunction` without the source location. */
export interface StorageFunctionInput {
  ref: { file: string; symbol: string };
  args: readonly StorageArgInput[];
  returns?: "changed" | "count" | "entity" | "throws";
  from?: readonly string[];
  to?: string;
}

/** `ir.StorageBinding` without source locations. */
export interface StorageBindingInput {
  key: string;
  read: readonly StorageFunctionInput[];
  save: readonly StorageFunctionInput[];
  update: readonly StorageFunctionInput[];
  atomic: readonly StorageFunctionInput[];
}

export interface StorageFakeConfig<E extends string = string> {
  /** The entity's name (`CodeSites.storage.collection`), e.g. `Order`: what `seed` and `read` take. */
  entity: E;
  /** The field holding the entity's state (`EntityDecl.stateField`), e.g. `status`. */
  state: string;
  /** The spec's `bindings.storage` (named-function form). */
  binding: StorageBindingInput;
  /** Entities present at the start of every run (re-applied on each `reset()`). */
  seed?: readonly Row[];
  /**
   * What a read of a missing key does: `"undefined"` (default) returns `undefined`; a function's
   * result is thrown (e.g. `(key) => new NotFoundError(…)` to mirror the real function).
   */
  missing?: "undefined" | ((key: string) => unknown);
}

/** One of the app's storage functions, as the fake implements it. */
export type StorageFunctionImpl = (...args: unknown[]) => Promise<unknown>;

export interface StorageFake<E extends string = string> {
  /** Implementation per bound symbol: what the mocked modules export in place of the app's functions. */
  functions: Record<string, StorageFunctionImpl>;
  /** Adds or replaces entities for the current run (never gated). Config seeds come back on reset. */
  seed(rows: Partial<Record<E, readonly Row[]>>): void;
  /** A copy of the stored entity with that key (never gated; staged writes are not visible). */
  read(entity: E, key: string | number): Row | undefined;
  /** Copies of every stored entity, in insertion order. */
  rows(entity: E): Row[];
}

/** Thrown by an `update` with `returns: throws` when the stored state is not a from-state. */
export class StorageConditionError extends Error {
  override readonly name = "StorageConditionError";
}

/**
 * Thrown when code uses the stand-in transaction an `atomic` fake passes its callback: the code
 * that used it is not replaced by a fake, so the spec doesn't bind it.
 */
export class StandInTransactionError extends Error {
  override readonly name = "StandInTransactionError";
}

/** Properties read by `await`, JSON, test matchers and printers: harmless, answered `undefined`. */
const PASSIVE = new Set([
  "then",
  "toJSON",
  "constructor",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
]);

/**
 * What an `atomic` fake (`label`, e.g. `storage.withTransaction`) passes its callback in place of
 * the real transaction or lock handle. Passing it on is harmless (a bound storage function or
 * client takes it as a `_` argument and never looks at it); reading a property of it, setting one
 * or calling it throws a `StandInTransactionError` that names the property, e.g. `tx.insert`.
 */
export function standInTransaction(label: string): unknown {
  const used = (what: string): never => {
    throw new StandInTransactionError(
      `tsverify's stand-in transaction: \`${what}\` was used by code the spec doesn't bind. ${label} passes its callback this stand-in in place of the real transaction (or lock handle), and only the functions the spec binds are replaced by fakes; bind the function that uses it (a storage function under \`bindings.storage\`, or a client under \`bindings.clients\`), so the test replaces it.`,
    );
  };
  const text = () => `[tsverify stand-in transaction for ${label}]`;
  return new Proxy(function transaction() {}, {
    get(_target, property) {
      if (typeof property === "symbol" || PASSIVE.has(property) || property.startsWith("@@")) {
        return undefined;
      }
      if (property === "toString") return text;
      return used(`tx.${property}`);
    },
    set(_target, property) {
      return used(`tx.${String(property)} = …`);
    },
    apply() {
      return used("tx(…)");
    },
    construct() {
      return used("new tx(…)");
    },
  });
}

/** The gate prefix of every storage function (`CallSite.client`). */
export const STORAGE_CLIENT = "storage";

type Kind = "read" | "save" | "update" | "atomic";

interface Scope {
  owner: object;
  staged: Map<string, Row>;
}

export function storage<const E extends string>(
  s: Scheduler,
  config: StorageFakeConfig<E>,
): StorageFake<E> {
  const { entity, state, binding } = config;
  const owner = `storage fake for ${entity}`;
  const keyField = binding.key;
  const table = new Map<string, Row>();
  const scopes = new AsyncLocalStorage<Scope>();
  const self = {};

  const kinds: Kind[] = ["read", "save", "update", "atomic"];
  const all = kinds.flatMap((kind) => binding[kind].map((fn) => ({ kind, fn })));
  const atomics = all.filter((f) => f.kind === "atomic");
  const lockName =
    atomics.length === 1 ? `${STORAGE_CLIENT}.${atomics[0]?.fn.ref.symbol}` : STORAGE_CLIENT;
  for (const { kind, fn } of all) {
    s.defineGate(gateOf(fn), kind === "atomic" ? "transparent" : "sync", owner);
  }

  const scope = (): Scope | undefined => {
    const current = scopes.getStore();
    return current?.owner === self ? current : undefined;
  };
  const get = (key: string): Row | undefined => scope()?.staged.get(key) ?? table.get(key);
  const put = (key: string, row: Row): void => {
    const staged = scope()?.staged;
    if (staged) staged.set(key, row);
    else table.set(key, row);
  };

  const checkEntity = (name: string) => {
    if (name !== entity) {
      throw new Error(`${owner} has no entity ${JSON.stringify(name)} (it stores ${entity})`);
    }
  };
  const keyOf = (row: unknown, where: string): string => {
    const key = typeof row === "object" && row !== null ? (row as Row)[keyField] : undefined;
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error(
        `${where}: expected a ${entity} with a string or number "${keyField}" (the key), got ${preview(row, 60)}`,
      );
    }
    return String(key);
  };

  const reseed = () => {
    table.clear();
    for (const row of config.seed ?? []) {
      table.set(keyOf(row, `${owner} seed`), structuredClone(row));
    }
  };
  s.onReset(reseed);
  reseed();

  const functions: Record<string, StorageFunctionImpl> = {};
  for (const { kind, fn } of all) {
    const label = gateOf(fn);
    const pick = (args: readonly unknown[], role: StorageRoleInput): unknown => {
      const at = roleAt(fn, role);
      if (!at) return undefined;
      let value: unknown = args[at.index];
      for (const field of at.path) {
        value =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)[field]
            : undefined;
      }
      return value;
    };
    const has = (role: StorageRoleInput) => roleAt(fn, role) !== undefined;
    const keyArg = (args: readonly unknown[]): string => {
      const key = pick(args, "key");
      if (typeof key !== "string" && typeof key !== "number") {
        throw new Error(
          `${label}: ${where(fn, "key")} has the "key" role, but got ${preview(key, 60)} (a string or number)`,
        );
      }
      return String(key);
    };
    const objectArg = (args: readonly unknown[], role: "entity" | "patch"): Row => {
      const value = pick(args, role);
      // An optional trailing `patch` left out (`updateStatusIf(id, "paid", "refunded")`) merges nothing.
      if (role === "patch" && value === undefined) return {};
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
          `${label}: ${where(fn, role)} has the "${role}" role, but got ${preview(value, 60)} (an object)`,
        );
      }
      return structuredClone(value as Row);
    };

    switch (kind) {
      case "read":
        functions[fn.ref.symbol] = async (...args) => {
          const key = keyArg(args);
          await s.gate(label, [key]);
          const row = get(key);
          if (row !== undefined) return structuredClone(row);
          if (config.missing === undefined || config.missing === "undefined") return undefined;
          throw config.missing(key);
        };
        break;
      case "save":
        functions[fn.ref.symbol] = async (...args) => {
          if (has("entity")) {
            const row = objectArg(args, "entity");
            const key = has("key") ? keyArg(args) : keyOf(row, label);
            await s.gate(label, has("key") ? [key, row] : [row]);
            put(key, structuredClone({ [keyField]: key, ...row }));
            return undefined;
          }
          const key = keyArg(args);
          const patch = objectArg(args, "patch");
          await s.gate(label, [key, patch]);
          put(key, structuredClone({ ...(get(key) ?? { [keyField]: key }), ...patch }));
          return undefined;
        };
        break;
      case "update":
        functions[fn.ref.symbol] = async (...args) => {
          const key = keyArg(args);
          const from = has("from")
            ? statesArg(label, fn, pick(args, "from"))
            : [...(fn.from ?? [])];
          const to = has("to") ? pick(args, "to") : fn.to;
          if (typeof to !== "string") {
            throw new Error(`${label}: the target state must be a string, got ${preview(to, 60)}`);
          }
          const patch = has("patch") ? objectArg(args, "patch") : {};
          await s.gate(label, [key, from, to]);
          const row = get(key);
          const ok = row !== undefined && from.includes(row[state] as string);
          const returns = fn.returns ?? "changed";
          if (!ok) {
            if (returns === "throws") {
              const now = row === undefined ? "missing" : `${state} ${JSON.stringify(row[state])}`;
              throw new StorageConditionError(
                `${label}(${JSON.stringify(key)}): expected ${state} in [${from.join(", ")}], the stored ${entity} is ${now}`,
              );
            }
            return returns === "count" ? 0 : returns === "entity" ? undefined : false;
          }
          const updated = { ...row, ...patch, [state]: to };
          put(key, structuredClone(updated));
          return returns === "count"
            ? 1
            : returns === "entity"
              ? structuredClone(updated)
              : returns === "throws"
                ? undefined
                : true;
        };
        break;
      case "atomic": {
        const tx = standInTransaction(label);
        functions[fn.ref.symbol] = async (...args) => {
          const callback = pick(args, "callback");
          if (typeof callback !== "function") {
            throw new Error(
              `${label}: ${where(fn, "callback")} has the "callback" role, but got ${preview(callback, 60)} (a function)`,
            );
          }
          await s.gate(label, []);
          if (scope() !== undefined) return await callback(tx); // nested: part of the outer step
          const lock = s.lock(lockName);
          await lock.acquire();
          try {
            const staged = new Map<string, Row>();
            const result: unknown = await scopes.run({ owner: self, staged }, () => callback(tx));
            for (const [key, row] of staged) table.set(key, row);
            return result;
          } finally {
            lock.release();
          }
        };
        break;
      }
    }
  }

  return {
    functions,
    seed(rows) {
      for (const [name, list] of Object.entries(rows) as [E, readonly Row[] | undefined][]) {
        checkEntity(name);
        for (const row of list ?? []) table.set(keyOf(row, `${owner} seed`), structuredClone(row));
      }
    },
    read(name, key) {
      checkEntity(name);
      const row = table.get(String(key));
      return row === undefined ? undefined : structuredClone(row);
    },
    rows(name) {
      checkEntity(name);
      return [...table.values()].map((row) => structuredClone(row));
    },
  };
}

/** Where `role` is: the positional argument, and the field path inside it. */
function roleAt(
  fn: StorageFunctionInput,
  role: StorageRoleInput,
): { index: number; path: string[] } | undefined {
  const find = (arg: StorageArgInput, path: string[]): string[] | undefined => {
    if (typeof arg === "string") return arg === role ? path : undefined;
    for (const [field, inner] of Object.entries(arg)) {
      const found = find(inner, [...path, field]);
      if (found) return found;
    }
    return undefined;
  };
  for (const [index, arg] of fn.args.entries()) {
    const path = find(arg, []);
    if (path) return { index, path };
  }
  return undefined;
}

/** `argument 2`, or `field id of argument 1` for a field role. */
function where(fn: StorageFunctionInput, role: StorageRoleInput): string {
  const at = roleAt(fn, role);
  if (!at) return "no argument";
  return at.path.length === 0
    ? `argument ${at.index + 1}`
    : `field ${at.path.join(".")} of argument ${at.index + 1}`;
}

function gateOf(fn: StorageFunctionInput): string {
  return `${STORAGE_CLIENT}.${fn.ref.symbol}`;
}

/** A `from` argument: one state or a list of states. */
function statesArg(label: string, fn: StorageFunctionInput, value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return [...value];
  throw new Error(
    `${label}: ${where(fn, "from")} has the "from" role, but got ${preview(value, 60)} (a state or a list of states)`,
  );
}
