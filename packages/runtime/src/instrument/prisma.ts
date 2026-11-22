/**
 * `instrument.prisma`: an in-memory, Prisma-shaped client fake for the `prisma` persistence
 * pattern. It mirrors the call shapes of a generated `PrismaClient` (`db.order.findUnique(…)`,
 * `db.order.updateMany(…)`, `db.$transaction(…)`), so the app's real code runs against it with no
 * database. It is configured from the extractor's `CodeSites` (`prismaConfigFromCode`):
 *
 * | Config   | From                                   | Example                               |
 * |----------|----------------------------------------|---------------------------------------|
 * | `client` | `CallSite.client` / `storage.client`   | `db`                                  |
 * | `models` | `storage.collection` + `storage.key`   | `order: { key: "id" }`                |
 * | `read`   | `read.path`                            | `order.findUnique`                    |
 * | `write`  | `commit.path`                          | `order.update`, `order.updateMany`    |
 *
 * Semantics:
 * - Every model in `models` gets the standard delegate methods (`findUnique`, `findUniqueOrThrow`,
 *   `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `create`, `update`, `updateMany`,
 *   `upsert`, `delete`, `deleteMany`). The paths in `read` / `write` are **sync** gates (the
 *   model's read and write points); the other methods are **transparent** gates. The work happens
 *   when the gate is passed, in one synchronous step: `updateMany` and an `update` whose `where`
 *   names more than the key are an **atomic compare-and-set** (match `where`, then apply `data`,
 *   with no other worker in between), exactly like the single SQL statement Prisma sends.
 * - `where`: field equality and the filters `equals`, `in`, `notIn`, `not`, `lt`, `lte`, `gt`,
 *   `gte`, `contains`, `startsWith`, `endsWith`, plus `AND` / `OR` / `NOT`. `data`: plain values and
 *   `set`, `increment`, `decrement`, `multiply`, `divide`. `select` projects the returned row.
 *   Relations (nested writes, `include`, relation filters) throw a clear error.
 * - Missing rows: `findUnique` / `findFirst` return `null`; `…OrThrow`, `update` and `delete` throw
 *   a `PrismaFakeError` with code `P2025` (like `PrismaClientKnownRequestError`); `updateMany`
 *   returns `{ count: 0 }`. `create` of an existing key throws code `P2002`.
 * - Calls return lazy **PrismaPromise**s: nothing runs (and no gate is reached) until the result
 *   is awaited or passed to `$transaction([…])`, as with the real client. The calling worker is
 *   captured when the call is made.
 * - `$transaction` is a **transparent** gate. **Interactive** form `$transaction(fn, options)`:
 *   with `options.isolationLevel === "Serializable"` it holds one scheduler lock per client for
 *   the whole callback (like `instrument.store`'s transaction: a second worker becomes `waiting`).
 *   At any other level (the default, READ COMMITTED on PostgreSQL) it takes **no** lock, so a
 *   read-then-write inside it can interleave with another worker, which is what a replay shows.
 *   **Array** form `$transaction([p1, p2], options)`: runs the operations in order, under the
 *   lock only when Serializable. Writes in a transaction apply when their gate is passed and are
 *   undone if it fails (so other workers can see uncommitted writes: never weaker isolation than
 *   the database, which would invent races). Calls on the root client inside the callback are
 *   outside the transaction. Not reentrant: `tx.$transaction` does not exist, as in Prisma.
 * - Copy on read and on write (`structuredClone`). Unknown models and members (`$queryRaw`, …)
 *   throw `UninstrumentedCallError` naming the config to add. `$connect` / `$disconnect` are
 *   no-ops.
 */
import { currentWorkerContext, runInWorker } from "../context";
import { preview } from "../preview";
import type { Scheduler } from "../scheduler";
import type { Row } from "./store";
import { strict } from "./strict";

/** The delegate methods every configured model has. */
export const PRISMA_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "create",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;
export type PrismaMethod = (typeof PRISMA_METHODS)[number];

export interface PrismaModelConfig {
  /** Primary-key field (`storage.key`), e.g. `id`. */
  key: string;
  /** Rows present at the start of every run (re-applied on each `reset()`). */
  seed?: readonly Row[];
}

export interface PrismaFakeConfig<M extends string = string> {
  /** Client binding name and gate prefix, e.g. `db` → gates `db.order.update`, `db.$transaction`. */
  client: string;
  /** Model delegates by name, e.g. `{ order: { key: "id" } }` for `db.order`. */
  models: Record<M, PrismaModelConfig>;
  /** Read paths `<model>.<method>` that are sync gates, e.g. `["order.findUnique"]`. */
  read: readonly string[];
  /** Write paths `<model>.<method>` that are sync gates, e.g. `["order.updateMany"]`. */
  write: readonly string[];
}

/** A Prisma-like known request error (`P2025` record not found, `P2002` unique constraint). */
export class PrismaFakeError extends Error {
  override readonly name = "PrismaClientKnownRequestError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Args = Record<string, unknown>;
/** A model delegate method of the fake: returns a lazy PrismaPromise. */
export type PrismaDelegateMethod = (args?: Args) => PromiseLike<unknown>;
export type PrismaDelegate = Record<PrismaMethod, PrismaDelegateMethod>;

export type PrismaFakeClient<M extends string> = { [K in M]: PrismaDelegate } & {
  $transaction(
    arg: ((tx: { [K in M]: PrismaDelegate }) => Promise<unknown>) | readonly PromiseLike<unknown>[],
    options?: { isolationLevel?: string; maxWait?: number; timeout?: number },
  ): Promise<unknown>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
};

export interface PrismaFake<M extends string = string> {
  /** What the mocked module exports in place of the real `PrismaClient` instance. */
  client: PrismaFakeClient<M>;
  /** Adds or replaces rows for the current run (never gated). Config seeds come back on reset. */
  seed(rows: Partial<Record<M, readonly Row[]>>): void;
  /** A copy of the stored row with that key (never gated). */
  read(model: M, key: string | number): Row | undefined;
  /** Copies of every stored row of a model, in insertion order. */
  rows(model: M): Row[];
}

const OPERATION = Symbol("tsverify.prisma.operation");

interface Lazy<T> extends PromiseLike<T> {
  catch(onRejected: (reason: unknown) => unknown): Promise<unknown>;
  finally(onFinally: () => void): Promise<T>;
  readonly [Symbol.toStringTag]: "PrismaPromise";
  /** Runs the operation against a transaction's view (array-form `$transaction`). */
  [OPERATION](view: View): Promise<T>;
}

/** Where operations read and write: the committed tables, plus an undo log in a transaction. */
interface View {
  undo?: (() => void)[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
}

function unsupported(what: string): Error {
  return new Error(
    `the Prisma fake does not support ${what}; it models scalar fields of one model at a time`,
  );
}

function fieldMatches(value: unknown, cond: unknown, field: string): boolean {
  if (!isPlainObject(cond)) return same(value, cond);
  for (const [op, v] of Object.entries(cond)) {
    if (v === undefined || op === "mode") continue;
    const list = () => (Array.isArray(v) ? v : [v]);
    switch (op) {
      case "equals":
        if (!same(value, v)) return false;
        break;
      case "in":
        if (!list().some((x) => same(value, x))) return false;
        break;
      case "notIn":
        if (list().some((x) => same(value, x))) return false;
        break;
      case "not":
        if (isPlainObject(v) ? fieldMatches(value, v, field) : same(value, v)) return false;
        break;
      case "lt":
        if (!(compare(value, v) < 0)) return false;
        break;
      case "lte":
        if (!(compare(value, v) <= 0)) return false;
        break;
      case "gt":
        if (!(compare(value, v) > 0)) return false;
        break;
      case "gte":
        if (!(compare(value, v) >= 0)) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.includes(String(v))) return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(String(v))) return false;
        break;
      case "endsWith":
        if (typeof value !== "string" || !value.endsWith(String(v))) return false;
        break;
      default:
        throw unsupported(`the filter ${JSON.stringify(op)} on ${JSON.stringify(field)}`);
    }
  }
  return true;
}

function rowMatches(row: Row, where: unknown): boolean {
  if (where === undefined) return true;
  if (!isPlainObject(where)) throw unsupported(`a \`where\` of ${preview(where, 60)}`);
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const list = Array.isArray(cond) ? cond : [cond];
    if (k === "AND") {
      if (!list.every((w) => rowMatches(row, w))) return false;
    } else if (k === "OR") {
      if (!list.some((w) => rowMatches(row, w))) return false;
    } else if (k === "NOT") {
      if (list.some((w) => rowMatches(row, w))) return false;
    } else if (!fieldMatches(row[k], cond, k)) return false;
  }
  return true;
}

function applyData(row: Row, data: unknown): Row {
  if (!isPlainObject(data)) throw unsupported(`\`data\` of ${preview(data, 60)}`);
  const next: Row = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (!isPlainObject(v)) {
      next[k] = structuredClone(v);
      continue;
    }
    const ops = Object.keys(v);
    const [op] = ops;
    if (ops.length !== 1 || op === undefined) throw unsupported(`the update ${preview(v, 60)}`);
    const n = v[op];
    const cur = next[k] as number;
    if (op === "set") next[k] = structuredClone(n);
    else if (op === "increment") next[k] = cur + (n as number);
    else if (op === "decrement") next[k] = cur - (n as number);
    else if (op === "multiply") next[k] = cur * (n as number);
    else if (op === "divide") next[k] = cur / (n as number);
    else throw unsupported(`the nested write ${JSON.stringify(op)} on ${JSON.stringify(k)}`);
  }
  return next;
}

function project(row: Row, args: Args | undefined): Row {
  if (args?.include !== undefined) throw unsupported("`include` (relations)");
  const select = args?.select;
  const copy = structuredClone(row);
  if (!isPlainObject(select)) return copy;
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) {
    if (on === true) out[k] = copy[k];
    else if (on !== false && on !== undefined) throw unsupported("a nested `select` (relations)");
  }
  return out;
}

export function prisma<const M extends string>(
  s: Scheduler,
  config: PrismaFakeConfig<M>,
): PrismaFake<M> {
  const { client: name } = config;
  const owner = `prisma fake "${name}"`;
  const models = Object.keys(config.models) as M[];
  const tables = new Map<string, Map<string, Row>>(models.map((m) => [m, new Map()]));
  const txLabel = `${name}.$transaction`;

  const table = (m: string): Map<string, Row> => {
    const t = tables.get(m);
    if (!t)
      throw new Error(`${owner} has no model ${JSON.stringify(m)} (models: ${models.join(", ")})`);
    return t;
  };
  const keyField = (m: string): string => config.models[m as M].key;
  const keyOf = (m: string, row: unknown, where: string): string => {
    const field = keyField(m);
    const key = isPlainObject(row) ? row[field] : undefined;
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error(
        `${where}: expected a ${m} row with a string or number "${field}" (the model's key), ` +
          `got ${preview(row, 60)}`,
      );
    }
    return String(key);
  };

  // Gates: listed paths are sync, every other delegate method is transparent.
  const sync = new Set<string>();
  for (const [role, paths] of [
    ["read", config.read],
    ["write", config.write],
  ] as const) {
    for (const path of paths) {
      const [model, method, ...rest] = path.split(".");
      if (
        !model ||
        !method ||
        rest.length > 0 ||
        !(PRISMA_METHODS as readonly string[]).includes(method)
      ) {
        throw new Error(
          `${owner}: ${role} path ${JSON.stringify(path)} must be "<model>.<method>" with a Prisma delegate method (${PRISMA_METHODS.join(", ")})`,
        );
      }
      table(model);
      if (sync.has(path)) throw new Error(`${owner}: ${name}.${path} is listed twice`);
      sync.add(path);
    }
  }
  for (const m of models) {
    for (const method of PRISMA_METHODS) {
      const path = `${m}.${method}`;
      s.defineGate(`${name}.${path}`, sync.has(path) ? "sync" : "transparent", owner);
    }
  }
  s.defineGate(txLabel, "transparent", owner);

  const reseed = () => {
    for (const m of models) {
      const t = table(m);
      t.clear();
      for (const row of config.models[m].seed ?? []) {
        t.set(keyOf(m, row, `${owner} seed`), structuredClone(row));
      }
    }
  };
  s.onReset(reseed);
  reseed();

  /** Writes `row` (or deletes when undefined) under `key`, recording the undo in a transaction. */
  const put = (view: View, m: string, key: string, row: Row | undefined) => {
    const t = table(m);
    if (view.undo) {
      const before = t.get(key);
      view.undo.push(() => {
        if (before === undefined) t.delete(key);
        else t.set(key, before);
      });
    }
    if (row === undefined) t.delete(key);
    else t.set(key, structuredClone(row));
  };

  const notFound = (label: string, args: Args | undefined) =>
    new PrismaFakeError(
      "P2025",
      `${label}: no record matches where ${preview(args?.where, 80)} (P2025, record not found)`,
    );

  /** One delegate operation, run synchronously once its gate is passed. */
  const operations: Record<
    PrismaMethod,
    (view: View, m: string, label: string, args: Args | undefined) => unknown
  > = {
    findUnique: (_v, m, _l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      return row === undefined ? null : project(row, a);
    },
    findUniqueOrThrow: (_v, m, l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      if (row === undefined) throw notFound(l, a);
      return project(row, a);
    },
    findFirst: (_v, m, _l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      return row === undefined ? null : project(row, a);
    },
    findFirstOrThrow: (_v, m, l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      if (row === undefined) throw notFound(l, a);
      return project(row, a);
    },
    findMany: (_v, m, _l, a) =>
      [...table(m).values()].filter((r) => rowMatches(r, a?.where)).map((r) => project(r, a)),
    count: (_v, m, _l, a) => [...table(m).values()].filter((r) => rowMatches(r, a?.where)).length,
    create: (v, m, l, a) => {
      const data = applyData({}, a?.data);
      const field = keyField(m);
      if (data[field] === undefined) data[field] = `${m}_${table(m).size + 1}`;
      const key = keyOf(m, data, l);
      if (table(m).has(key)) {
        throw new PrismaFakeError("P2002", `${l}: unique constraint failed on ${field} (P2002)`);
      }
      put(v, m, key, data);
      return project(data, a);
    },
    update: (v, m, l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      if (row === undefined) throw notFound(l, a);
      const next = applyData(row, a?.data);
      put(v, m, keyOf(m, row, l), next);
      return project(next, a);
    },
    updateMany: (v, m, l, a) => {
      const rows = [...table(m).values()].filter((r) => rowMatches(r, a?.where));
      for (const row of rows) put(v, m, keyOf(m, row, l), applyData(row, a?.data));
      return { count: rows.length };
    },
    upsert: (v, m, l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      if (row !== undefined) {
        const next = applyData(row, a?.update);
        put(v, m, keyOf(m, row, l), next);
        return project(next, a);
      }
      return operations.create(v, m, l, { ...a, data: a?.create });
    },
    delete: (v, m, l, a) => {
      const row = [...table(m).values()].find((r) => rowMatches(r, a?.where));
      if (row === undefined) throw notFound(l, a);
      put(v, m, keyOf(m, row, l), undefined);
      return project(row, a);
    },
    deleteMany: (v, m, l, a) => {
      const rows = [...table(m).values()].filter((r) => rowMatches(r, a?.where));
      for (const row of rows) put(v, m, keyOf(m, row, l), undefined);
      return { count: rows.length };
    },
  };

  /** A lazy PrismaPromise: runs on first `then`, in the worker that made the call. */
  const lazy = <T>(defaultView: View, op: (view: View) => Promise<T>): Lazy<T> => {
    const ctx = currentWorkerContext();
    let started: Promise<T> | undefined;
    const run = (view: View): Promise<T> => (ctx ? runInWorker(ctx, () => op(view)) : op(view));
    const start = (): Promise<T> => {
      started ??= run(defaultView);
      return started;
    };
    return {
      // biome-ignore lint/suspicious/noThenProperty: a PrismaPromise is a thenable by design
      then: (onFulfilled, onRejected) => start().then(onFulfilled, onRejected),
      catch: (onRejected) => start().catch(onRejected),
      finally: (onFinally) => start().finally(onFinally),
      [Symbol.toStringTag]: "PrismaPromise",
      [OPERATION]: (view) => {
        if (started) throw new Error(`${owner}: an operation passed to $transaction already ran`);
        started = run(view);
        return started;
      },
    };
  };

  const delegates = (view: View): Record<string, Record<string, unknown>> => {
    const api: Record<string, Record<string, unknown>> = {};
    for (const m of models) {
      const delegate: Record<string, unknown> = {};
      for (const method of PRISMA_METHODS) {
        const label = `${name}.${m}.${method}`;
        delegate[method] = (args?: Args) => {
          if (args !== undefined && !isPlainObject(args)) {
            throw new Error(`${label}(${preview(args, 60)}): expected an arguments object`);
          }
          const copy = args === undefined ? undefined : structuredClone(args);
          return lazy(view, async (v) => {
            await s.gate(label, copy === undefined ? [] : [copy]);
            return operations[method](v, m, label, copy);
          });
        };
      }
      api[m] = delegate;
    }
    return api;
  };

  const hint = (inTx: boolean) => (path: string) => {
    const [, model = "", method] = path.split(".");
    const where = inTx ? ` (on the \`tx\` passed by ${txLabel})` : "";
    const head = `${path}${where} is not instrumented: the prisma fake for client "${name}" has the models ${models.join(", ") || "(none)"}.`;
    if (inTx && model === "$transaction") {
      return `${head} Prisma's interactive transaction client has no $transaction (transactions do not nest).`;
    }
    if (model.startsWith("$")) {
      return `${head} ${model} (raw SQL, extensions, middleware) is not modelled by the fake.`;
    }
    if (!tables.has(model)) {
      return `${head} If ${JSON.stringify(model)} is a model, add \`${model}: { key: "id" }\` to \`models\`.`;
    }
    return `${head} ${model}.${method ?? ""} is not a Prisma delegate method the fake implements (${PRISMA_METHODS.join(", ")}).`;
  };

  const committed: View = {};

  const transaction = async (arg: unknown, options?: unknown): Promise<unknown> => {
    const level = isPlainObject(options) ? options.isolationLevel : undefined;
    const interactive = typeof arg === "function";
    if (!interactive && !Array.isArray(arg)) {
      throw new Error(
        `${txLabel}(${preview(arg, 60)}): expected a callback or an array of operations`,
      );
    }
    await s.gate(txLabel, []);
    const lock = level === "Serializable" ? s.lock(txLabel) : undefined;
    await lock?.acquire();
    const view: View = { undo: [] };
    try {
      if (interactive) {
        const tx = strict(delegates(view), name, hint(true));
        return await (arg as (tx: unknown) => Promise<unknown>)(tx);
      }
      const results: unknown[] = [];
      for (const op of arg as unknown[]) {
        const run = (op as Partial<Lazy<unknown>> | null)?.[OPERATION];
        if (typeof run !== "function") {
          throw new Error(
            `${txLabel}([…]): every element must be a call on this client (a PrismaPromise)`,
          );
        }
        results.push(await run(view));
      }
      return results;
    } catch (error) {
      for (const undo of (view.undo ?? []).reverse()) undo();
      throw error;
    } finally {
      lock?.release();
    }
  };

  const root: Record<string, unknown> = {
    ...delegates(committed),
    $transaction: transaction,
    $connect: async () => {},
    $disconnect: async () => {},
  };

  return {
    client: strict(root, name, hint(false)) as unknown as PrismaFakeClient<M>,
    seed(rows) {
      for (const [m, list] of Object.entries(rows) as [M, readonly Row[] | undefined][]) {
        const t = table(m);
        for (const row of list ?? []) t.set(keyOf(m, row, `${owner} seed`), structuredClone(row));
      }
    },
    read(m, key) {
      const row = table(m).get(String(key));
      return row === undefined ? undefined : structuredClone(row);
    },
    rows(m) {
      return [...table(m).values()].map((row) => structuredClone(row));
    },
  };
}
