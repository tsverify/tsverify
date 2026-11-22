/**
 * Structural views of the extractor's code facts (`ir.CodeSites`, `ir.BehaviorModel`) and the
 * derivation of a `ReplayMapping` from them. Structural because the runtime has no internal
 * dependencies; `test/ir-compat.test.ts` proves the `ir` types are assignable.
 */
import type { EffectsConfig } from "./instrument/effects.js";
import type { PrismaFakeConfig } from "./instrument/prisma.js";
import type { StoreConfig } from "./instrument/store.js";
import type { ReplayMapping } from "./plan.js";

/** `ir.CallSite` without the source location. */
export interface CallSiteInput {
  /** Client binding name, e.g. `db`. */
  client: string;
  /** Member path below the client, e.g. `orders.get`. */
  path: string;
  /** `${client}.${path}`: the gate label. */
  gate: string;
  /** 0-based occurrence of `gate` within one invocation of the impl. */
  occurrence: number;
}

/** The subset of `ir.CodeSites` replay reads. */
export interface CodeSitesInput {
  specTransition?: string;
  read?: CallSiteInput;
  commit?: CallSiteInput;
  atomic?: { kind: string; gate?: string };
  effects: readonly (CallSiteInput & { effect: string })[];
  invocation?: {
    impl: { file: string; symbol: string };
    entityId: { param: number; path: readonly string[] };
    actor?: { param: number; path: readonly string[] };
  };
  storage?: { client: string; collection: string; key: string };
}

/** The subset of an `ir.BehaviorModel` with `origin: "code"` that replay reads. */
export interface CodeModelInput {
  transitions: readonly { name: string; sites?: CodeSitesInput }[];
  bindings?: { effects: Readonly<Record<string, string>> };
}

/**
 * Model action → sync gates, from each linked code transition's sites:
 * - `read` → the read call (`db.orders.get`)
 * - `write` → the commit call (`db.orders.save`)
 * - `atomic` → read, then commit
 *
 * The atomic scope's gate (`db.transaction`) and effect gates are transparent: a step passes them
 * on its way, so the same schedule drives code with or without a transaction (which is the point:
 * the replay finds out whether the code serialises the workers). A call repeated before the
 * relevant occurrence (`occurrence > 0`) is listed once per occurrence.
 *
 * Only the write named after its spec transition is used (`refund`, not `refund->cancelled` or
 * unlinked writes), because that is the one a trace action of that transition stands for.
 */
export function mappingFromCode(code: CodeModelInput): ReplayMapping {
  const transitions: Record<string, { read: string[]; write: string[]; atomic: string[] }> = {};
  const effects: Record<string, string> = { ...code.bindings?.effects };
  const sorted = [...code.transitions].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const t of sorted) {
    const sites = t.sites;
    if (!sites || sites.specTransition !== t.name) continue;
    const seen = new Map<string, number>();
    const upTo = (site: CallSiteInput | undefined): string[] => {
      if (!site) return [];
      const already = seen.get(site.gate) ?? 0;
      const count = Math.max(1, site.occurrence + 1 - already);
      seen.set(site.gate, already + count);
      return Array.from({ length: count }, () => site.gate);
    };
    const read = upTo(sites.read);
    const write = upTo(sites.commit);
    transitions[t.name] = { read, write, atomic: [...read, ...write] };
    for (const e of sites.effects) effects[e.effect] ??= e.gate;
  }
  return { transitions, effects };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function allSites(code: CodeModelInput): CodeSitesInput[] {
  return code.transitions.flatMap((t) => (t.sites ? [t.sites] : []));
}

type DottedPath = `${string}.${string}`;

/**
 * `instrument.store` config for one repository client, from every code transition's sites:
 * collections and keys from `storage`, read and commit paths from `read` / `commit`, and the
 * transaction method from a `transaction` atomic scope's gate. Add `missing` and `seed` yourself.
 */
export function storeConfigFromCode(
  code: CodeModelInput,
  client: string,
): StoreConfig<string, DottedPath, DottedPath, string> {
  const sites = allSites(code);
  const collections: Record<string, { key: string }> = {};
  for (const s of sites) {
    if (s.storage?.client === client) collections[s.storage.collection] = { key: s.storage.key };
  }
  const paths = (pick: (s: CodeSitesInput) => CallSiteInput | undefined) =>
    sortedUnique(
      sites.flatMap((s) => {
        const site = pick(s);
        return site?.client === client ? [site.path] : [];
      }),
    ) as DottedPath[];
  const transactions = sortedUnique(
    sites.flatMap((s) =>
      s.atomic?.kind === "transaction" && s.atomic.gate?.startsWith(`${client}.`)
        ? [s.atomic.gate.slice(client.length + 1)]
        : [],
    ),
  );
  if (transactions.length > 1) {
    throw new Error(
      `client "${client}" opens transactions through several methods (${transactions.join(", ")}); ` +
        "the store fake supports one",
    );
  }
  const config: StoreConfig<string, DottedPath, DottedPath, string> = {
    client,
    collections,
    read: paths((s) => s.read),
    commit: paths((s) => s.commit),
  };
  if (transactions[0] !== undefined) config.transaction = transactions[0];
  return config;
}

/**
 * `instrument.prisma` config for one Prisma client, from every code transition's sites: models
 * and keys from `storage`, sync read paths from `read`, sync write paths from `commit`. A model a
 * read or write names without a `storage` site gets key `id`. `$transaction` needs no config (the
 * fake decides per call, from its `isolationLevel`).
 */
export function prismaConfigFromCode(code: CodeModelInput, client: string): PrismaFakeConfig {
  const sites = allSites(code);
  const models: Record<string, { key: string }> = {};
  for (const s of sites) {
    if (s.storage?.client === client) models[s.storage.collection] = { key: s.storage.key };
  }
  const paths = (pick: (s: CodeSitesInput) => CallSiteInput | undefined) =>
    sortedUnique(
      sites.flatMap((s) => {
        const site = pick(s);
        return site?.client === client ? [site.path] : [];
      }),
    );
  const read = paths((s) => s.read);
  const write = paths((s) => s.commit);
  for (const path of [...read, ...write]) {
    const model = path.split(".")[0] ?? "";
    models[model] ??= { key: "id" };
  }
  return { client, models, read, write };
}

/** `instrument.effects` config for one effect client: every effect call path on it. */
export function effectsConfigFromCode(code: CodeModelInput, client: string): EffectsConfig {
  const calls = sortedUnique(
    allSites(code).flatMap((s) => s.effects.filter((e) => e.client === client).map((e) => e.path)),
  );
  return { client, calls };
}
