import type { GateKind, Scheduler } from "./scheduler";

export type Row = Record<string, unknown>;

export interface StoreOptions<C extends string> {
  /** Client name used as the gate prefix, e.g. `db` → `db.orders.get`. */
  name: string;
  /** Collections and their primary-key field. */
  collections: Record<C, { key: string }>;
}

export interface Repo {
  get(key: string): Promise<Row | undefined>;
  save(row: Row): Promise<void>;
}

export type StoreClient<C extends string> = Record<C, Repo> & {
  transaction<T>(fn: (tx: Record<C, Repo>) => Promise<T>): Promise<T>;
};

export interface StoreFake<C extends string> {
  /** What the mocked module exports in place of the real client. */
  client: StoreClient<C>;
  /** Test-side access (never gated). */
  seed(collection: C, rows: Row[]): void;
  rows(collection: C): Row[];
}

/**
 * In-memory repository fake with the same API as the app's `db`:
 * `<collection>.get(key)`, `<collection>.save(row)`, and `transaction(fn)`.
 *
 * Gates:
 * - `<name>.<collection>.get` / `.save` are **sync** gates (the model's read and write points).
 *   The read happens when the gate is passed, not when it is reached.
 * - `<name>.transaction` is a **transparent** gate. Passing it requests the transaction lock; a
 *   worker that finds the lock held becomes `waiting`, and when the holder commits it becomes
 *   `ready`: it holds the lock but does not run until the schedule resumes it.
 * - Writes inside a transaction are staged and applied on commit; reads see staged rows first.
 *   Commit and lock release happen in the committing worker's step (no separate gate).
 */
function store<C extends string>(s: Scheduler, opts: StoreOptions<C>): StoreFake<C> {
  const names = Object.keys(opts.collections) as C[];
  const tables = new Map<C, Map<string, Row>>(names.map((c) => [c, new Map()]));
  const txGate = `${opts.name}.transaction`;
  s.defineGate(txGate, "transparent");
  for (const c of names) {
    s.defineGate(`${opts.name}.${c}.get`, "sync");
    s.defineGate(`${opts.name}.${c}.save`, "sync");
  }
  s.onReset(() => {
    for (const t of tables.values()) t.clear();
  });

  const table = (c: C): Map<string, Row> => {
    const t = tables.get(c);
    if (!t) throw new Error(`unknown collection ${c}`);
    return t;
  };
  const keyOf = (c: C, row: Row): string => String(row[opts.collections[c].key]);

  type View = { read(c: C, key: string): Row | undefined; write(c: C, row: Row): void };
  const repos = (view: View): Record<C, Repo> => {
    const out = {} as Record<C, Repo>;
    for (const c of names) {
      out[c] = {
        async get(key) {
          await s.gate(`${opts.name}.${c}.get`, [key]);
          const row = view.read(c, key);
          return row ? structuredClone(row) : undefined;
        },
        async save(row) {
          await s.gate(`${opts.name}.${c}.save`, [structuredClone(row)]);
          view.write(c, structuredClone(row));
        },
      };
    }
    return out;
  };

  const direct: View = {
    read: (c, key) => table(c).get(key),
    write: (c, row) => table(c).set(keyOf(c, row), row),
  };

  const client = {
    ...repos(direct),
    async transaction<T>(fn: (tx: Record<C, Repo>) => Promise<T>): Promise<T> {
      await s.gate(txGate, []);
      const lock = s.lock(txGate);
      await lock.acquire();
      try {
        const staged = new Map<C, Map<string, Row>>(names.map((c) => [c, new Map()]));
        const stagedTable = (c: C) => staged.get(c) as Map<string, Row>;
        const result = await fn(
          repos({
            read: (c, key) => stagedTable(c).get(key) ?? table(c).get(key),
            write: (c, row) => stagedTable(c).set(keyOf(c, row), row),
          }),
        );
        for (const [c, rows] of staged) for (const [k, row] of rows) table(c).set(k, row);
        return result;
      } finally {
        lock.release();
      }
    },
  } as StoreClient<C>;

  return {
    client,
    seed(c, rows) {
      for (const row of rows) table(c).set(keyOf(c, row), structuredClone(row));
    },
    rows(c) {
      return [...table(c).values()].map((r) => structuredClone(r));
    },
  };
}

export interface EffectsOptions {
  /** Client name used as the gate prefix, e.g. `stripe` → `stripe.refunds.create`. */
  name: string;
  /** Call paths below the client, e.g. `["refunds.create"]`. */
  calls: string[];
  /** Fake return values per path; default `{ id: "<path>_fake_<n>" }`. */
  returns?: Record<string, (args: readonly unknown[], n: number) => unknown>;
  /** Default `transparent`: effects fire on the way to the next sync gate. */
  gate?: GateKind;
}

export interface EffectsFake {
  /** What the mocked module exports in place of the real client. */
  client: Record<string, unknown>;
}

/** Records every call (worker, args, order) and gates it. Build nested objects from paths. */
function effects(s: Scheduler, opts: EffectsOptions): EffectsFake {
  const client: Record<string, unknown> = {};
  const counters = new Map<string, number>();
  s.onReset(() => counters.clear());
  for (const path of opts.calls) {
    const label = `${opts.name}.${path}`;
    s.defineGate(label, opts.gate ?? "transparent");
    const parts = path.split(".");
    const last = parts.pop() as string;
    let obj = client;
    for (const p of parts) {
      obj[p] ??= {};
      obj = obj[p] as Record<string, unknown>;
    }
    obj[last] = async (...args: unknown[]) => {
      await s.gate(label, args);
      s.recordEffect(label, args);
      const n = (counters.get(label) ?? 0) + 1;
      counters.set(label, n);
      const make = opts.returns?.[path];
      return make ? make(args, n) : { id: `${path.replaceAll(".", "_")}_fake_${n}` };
    };
  }
  return { client };
}

export const instrument = { store, effects };
