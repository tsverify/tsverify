/**
 * `instrument.store`: an in-memory repository fake for the `assign` persistence pattern
 * (`db.orders.get(id)` → mutate → `db.orders.save(order)`, optionally inside
 * `db.transaction(async (tx) => …)`). It is configured from the extractor's `CodeSites`:
 *
 * | Config        | From                                   | Example        |
 * |---------------|----------------------------------------|----------------|
 * | `client`      | `CallSite.client` / `storage.client`   | `db`           |
 * | `collections` | `storage.collection` + `storage.key`   | `orders: {key: "id"}` |
 * | `read`        | `read.path`                            | `orders.get`   |
 * | `commit`      | `commit.path`                          | `orders.save`  |
 * | `transaction` | `atomic.gate` minus the client         | `transaction`  |
 *
 * Semantics:
 * - Read and commit methods are **sync** gates (the model's read and write points). The work
 *   happens when the gate is passed, not when it is reached: a read returns the rows as they are at
 *   pass time.
 * - Copy on read and copy on write (`structuredClone`): the code under test never holds a
 *   reference into the store, exactly like a database round trip.
 * - The transaction method is a **transparent** gate. Passing it requests one serialized mutex
 *   per store. A worker that finds it held becomes `waiting`; when the holder finishes it becomes
 *   `ready` (holds the lock, does not run until resumed). Inside the callback, reads see staged
 *   rows first; staged writes are applied when the callback resolves (commit) and dropped when it
 *   throws (rollback). Not reentrant: a nested transaction is a `deadlock`.
 * - Unknown members throw `UninstrumentedCallError` naming the call and the config to add.
 */
import { preview } from "../preview";
import type { Scheduler } from "../scheduler";
import { strict } from "./strict";

export type Row = Record<string, unknown>;

export interface CollectionConfig {
  /** Primary-key field (`storage.key`), e.g. `id`. */
  key: string;
  /** Rows present at the start of every run (re-applied on each `reset()`). */
  seed?: readonly Row[];
}

export interface StoreConfig<
  C extends string = string,
  R extends string = string,
  W extends string = string,
  T extends string = string,
> {
  /** Client binding name and gate prefix, e.g. `db` → gates `db.orders.get`, `db.transaction`. */
  client: string;
  collections: Record<C, CollectionConfig>;
  /** Read paths `<collection>.<method>`: `(key) => row`, e.g. `["orders.get"]`. */
  read: readonly R[];
  /** Commit paths `<collection>.<method>`: `(row) => void`, upsert by key, e.g. `["orders.save"]`. */
  commit: readonly W[];
  /** Transaction method on the client, e.g. `transaction`. Omit when the code never opens one. */
  transaction?: T;
  /**
   * What a read of a missing key does: `"undefined"` (default) returns `undefined`; a function's
   * result is thrown (e.g. `(c, key) => new NotFoundError(…)` to mirror the real client).
   */
  missing?: "undefined" | ((collection: C, key: string) => unknown);
}

type Methods<P extends string, C extends string> = P extends `${C}.${infer M}` ? M : never;

/** Returns a copy of the row with that key, or what `missing` says. */
export type ReadMethod = (key: string | number) => Promise<Row | undefined>;
/** Stores a copy of the row under its key (insert or replace). */
export type CommitMethod = (row: object) => Promise<void>;

/** The collection API, shared by the client and the transaction callback's `tx`. */
export type StoreCollections<C extends string, R extends string, W extends string> = {
  [K in C]: { [M in Methods<R, K>]: ReadMethod } & { [M in Methods<W, K>]: CommitMethod };
};

export type StoreClient<
  C extends string,
  R extends string,
  W extends string,
  T extends string,
> = StoreCollections<C, R, W> & {
  [K in T]: <X>(fn: (tx: StoreCollections<C, R, W>) => Promise<X>) => Promise<X>;
};

export interface StoreFake<
  C extends string = string,
  R extends string = string,
  W extends string = string,
  T extends string = string,
> {
  /** What the mocked module exports in place of the real client. */
  client: StoreClient<C, R, W, T>;
  /** Adds or replaces rows for the current run (never gated). Config seeds come back on reset. */
  seed(rows: Partial<Record<C, readonly Row[]>>): void;
  /** A copy of the committed row with that key (never gated; staged writes are not visible). */
  read(collection: C, key: string | number): Row | undefined;
  /** Copies of every committed row of a collection, in insertion order. */
  rows(collection: C): Row[];
}

interface MethodSite {
  collection: string;
  method: string;
  label: string;
}

type View = {
  get(collection: string, key: string): Row | undefined;
  put(collection: string, key: string, row: Row): void;
};

export function store<
  const C extends string,
  const R extends `${C}.${string}`,
  const W extends `${C}.${string}`,
  const T extends string = never,
>(s: Scheduler, config: StoreConfig<C, R, W, T>): StoreFake<C, R, W, T> {
  const { client: name } = config;
  const owner = `store fake "${name}"`;
  const collections = Object.keys(config.collections) as C[];
  const tables = new Map<string, Map<string, Row>>(collections.map((c) => [c, new Map()]));

  const table = (c: string): Map<string, Row> => {
    const t = tables.get(c);
    if (!t) {
      throw new Error(
        `${owner} has no collection ${JSON.stringify(c)} (collections: ${collections.join(", ")})`,
      );
    }
    return t;
  };

  const keyOf = (c: string, row: unknown, where: string): string => {
    const field = config.collections[c as C].key;
    const key = typeof row === "object" && row !== null ? (row as Row)[field] : undefined;
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error(
        `${where}: expected a ${c} row with a string or number "${field}" (the collection's key), ` +
          `got ${preview(row, 60)}`,
      );
    }
    return String(key);
  };

  const sites = (paths: readonly string[], role: string): MethodSite[] =>
    paths.map((path) => {
      const [collection, method, ...rest] = path.split(".");
      if (!collection || !method || rest.length > 0) {
        throw new Error(
          `${owner}: ${role} path ${JSON.stringify(path)} must be "<collection>.<method>"`,
        );
      }
      table(collection);
      return { collection, method, label: `${name}.${path}` };
    });
  const reads = sites(config.read, "read");
  const commits = sites(config.commit, "commit");
  const txMethod = config.transaction;
  const txLabel = txMethod === undefined ? undefined : `${name}.${txMethod}`;
  if (txMethod !== undefined && (txMethod.includes(".") || tables.has(txMethod))) {
    throw new Error(
      `${owner}: transaction method ${JSON.stringify(txMethod)} must be a plain name that is not a collection`,
    );
  }
  const labels = [...reads, ...commits].map((site) => site.label);
  const twice = labels.find((label, i) => labels.indexOf(label) !== i);
  if (twice !== undefined) {
    throw new Error(`${owner}: ${twice} is listed twice (a path is either a read or a commit)`);
  }

  for (const site of [...reads, ...commits]) s.defineGate(site.label, "sync", owner);
  if (txLabel !== undefined) s.defineGate(txLabel, "transparent", owner);

  const reseed = () => {
    for (const c of collections) {
      const t = table(c);
      t.clear();
      for (const row of config.collections[c].seed ?? []) {
        t.set(keyOf(c, row, `${owner} seed`), structuredClone(row));
      }
    }
  };
  s.onReset(reseed);
  reseed();

  const missingRow = (c: string, key: string): undefined => {
    if (config.missing === undefined || config.missing === "undefined") return undefined;
    throw config.missing(c as C, key);
  };

  const collectionsApi = (view: View): Record<string, Record<string, unknown>> => {
    const api: Record<string, Record<string, unknown>> = {};
    for (const c of collections) api[c] = {};
    const define = (site: MethodSite, fn: unknown) => {
      (api[site.collection] as Record<string, unknown>)[site.method] = fn;
    };
    for (const site of reads) {
      define(site, async (key: unknown): Promise<Row | undefined> => {
        if (typeof key !== "string" && typeof key !== "number") {
          throw new Error(
            `${site.label}(${preview(key, 60)}): the store fake looks rows up by key ` +
              `("${config.collections[site.collection as C].key}"); query objects are not supported.`,
          );
        }
        await s.gate(site.label, [key]);
        const row = view.get(site.collection, String(key));
        return row === undefined ? missingRow(site.collection, String(key)) : structuredClone(row);
      });
    }
    for (const site of commits) {
      define(site, async (row: unknown): Promise<void> => {
        const key = keyOf(site.collection, row, site.label);
        const copy = structuredClone(row as Row);
        await s.gate(site.label, [copy]);
        view.put(site.collection, key, structuredClone(copy));
      });
    }
    return api;
  };

  const committed: View = {
    get: (c, key) => table(c).get(key),
    put: (c, key, row) => table(c).set(key, row),
  };

  const known = [
    ...reads.map((r) => `${r.label} (read)`),
    ...commits.map((r) => `${r.label} (commit)`),
    ...(txLabel === undefined ? [] : [`${txLabel} (transaction)`]),
  ].join(", ");
  const hint = (inTx: boolean) => (path: string) => {
    const [, collection = "", method] = path.split(".");
    const where = inTx ? ` (on the \`tx\` passed by ${txLabel})` : "";
    const head = `${path}${where} is not instrumented: the store fake for client "${name}" knows ${known}.`;
    if (!tables.has(collection)) {
      return (
        `${head} If ${JSON.stringify(collection)} is a collection, add ` +
        `\`${collection}: { key: "id" }\` to \`collections\` and its methods to \`read\` / ` +
        "`commit`" +
        (inTx || txLabel !== undefined
          ? "."
          : `; if it is the transaction method, set \`transaction: ${JSON.stringify(collection)}\`.`)
      );
    }
    const rel = `${collection}.${method ?? ""}`;
    return (
      `${head} Add ${JSON.stringify(rel)} to \`read\` (returns the row with the given key) or to ` +
      "`commit` (stores the given row). Other repository methods (queries, deletes) are not " +
      "supported by the store fake."
    );
  };

  const root: Record<string, unknown> = collectionsApi(committed);
  if (txMethod !== undefined && txLabel !== undefined) {
    root[txMethod] = async (fn: unknown): Promise<unknown> => {
      if (typeof fn !== "function") {
        throw new Error(`${txLabel}(fn): expected a callback, got ${preview(fn, 60)}`);
      }
      await s.gate(txLabel, []);
      const lock = s.lock(txLabel);
      await lock.acquire();
      try {
        const staged = new Map<string, Map<string, Row>>(collections.map((c) => [c, new Map()]));
        const stagedTable = (c: string) => staged.get(c) as Map<string, Row>;
        const tx = strict(
          collectionsApi({
            get: (c, key) => stagedTable(c).get(key) ?? table(c).get(key),
            put: (c, key, row) => stagedTable(c).set(key, row),
          }),
          name,
          hint(true),
        );
        const result: unknown = await fn(tx);
        for (const [c, rows] of staged) for (const [key, row] of rows) table(c).set(key, row);
        return result;
      } finally {
        lock.release();
      }
    };
  }

  return {
    client: strict(root, name, hint(false)) as StoreClient<C, R, W, T>,
    seed(rows) {
      for (const [c, list] of Object.entries(rows) as [C, readonly Row[] | undefined][]) {
        const t = table(c);
        for (const row of list ?? []) t.set(keyOf(c, row, `${owner} seed`), structuredClone(row));
      }
    },
    read(c, key) {
      const row = table(c).get(String(key));
      return row === undefined ? undefined : structuredClone(row);
    },
    rows(c) {
      return [...table(c).values()].map((row) => structuredClone(row));
    },
  };
}
