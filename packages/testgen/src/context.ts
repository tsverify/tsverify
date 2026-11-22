/**
 * Everything the emitters share for one spec: which spec transitions can be driven (linked code
 * transition with an invocation shape and storage, `assign` or `prisma` persistence, actor
 * fixtures), the fake configurations derived from every code transition's `CodeSites`, and the
 * fixtures.
 * Whatever cannot be generated is recorded as an `info` finding instead.
 */
import {
  type BehaviorModel,
  type CodeSites,
  compareStrings,
  type Finding,
  type Fixtures,
  formatSymbolRef,
  type InvocationShape,
  type Transition,
} from "@tsverify/ir";
import { buildArgs, mentions } from "./invoke";
import { skipFinding } from "./skips";

export interface Storage {
  client: string;
  collection: string;
  key: string;
}

/** A spec transition the generated tests can drive. */
export interface Linked {
  spec: Transition;
  /** The code transition named after `spec` (the write of `spec.to` reached from its impl). */
  code: Transition;
  sites: CodeSites;
  invocation: InvocationShape;
  /** Explicit `fixtures.args` for this transition, if any. */
  fixtureArgs?: readonly unknown[];
  /** Whether the impl receives an actor (`InvocationShape.actor` or `$actor` in the fixture args). */
  takesActor: boolean;
  /** The permitted actor tests act as: the first actor in `by` with a fixture. */
  actor?: string;
  /** Argument list (code) acting as `actor`. */
  args: string;
}

export interface StoreFakeConfig {
  client: string;
  collections: Record<string, { key: string }>;
  read: string[];
  commit: string[];
  transaction?: string;
}

/** `instrument.prisma` config: like the runtime's `prismaConfigFromCode`. */
export interface PrismaFakeConfig {
  client: string;
  models: Record<string, { key: string }>;
  read: string[];
  write: string[];
}

/** Persistence kinds the generated tests have fakes for. */
const FAKED: ReadonlySet<string> = new Set(["assign", "prisma"]);

export interface EffectsFakeConfig {
  client: string;
  calls: string[];
}

export interface Context {
  spec: BehaviorModel;
  code: BehaviorModel;
  /** Generated directory, relative to the project root. */
  outDir: string;
  /** Spec file, relative to the project root. */
  specFile: string;
  behavior: string;
  fixtures: Fixtures;
  /** Where the entity lives (from the first drivable transition). */
  storage: Storage;
  /** The seeded entity's key: `fixtures.entity[storage.key]`. */
  id: string | number;
  /** `assign` storage clients (`instrument.store`). */
  stores: StoreFakeConfig[];
  /** `prisma` storage clients (`instrument.prisma`). */
  prismas: PrismaFakeConfig[];
  effects: EffectsFakeConfig[];
  /** Drivable spec transitions, by name (sorted). */
  linked: Map<string, Linked>;
}

export interface ContextInput {
  spec: BehaviorModel;
  code: BehaviorModel;
  outDir: string;
}

export function buildContext(input: ContextInput): { ctx?: Context; skipped: Finding[] } {
  const { spec, code, outDir } = input;
  if (spec.origin !== "spec") throw new Error(`testgen: spec has origin "${spec.origin}"`);
  if (code.origin !== "code") throw new Error(`testgen: code has origin "${code.origin}"`);
  const behavior = spec.name;
  const skipped: Finding[] = [];
  const skipAll = (subject: string, message: string, hint?: string) => ({
    skipped: [skipFinding(behavior, subject, message, hint === undefined ? {} : { hint })],
  });

  const persistence = spec.bindings.persistence ?? code.bindings.persistence;
  if (persistence === "memory") {
    return skipAll(
      "persistence",
      "tsverify test generated no tests: `memory` persistence has no fakes or replay support yet",
    );
  }
  const fixtures = spec.fixtures;
  if (fixtures === undefined) {
    return skipAll(
      "fixtures",
      "tsverify test generated no tests: the spec has no `fixtures` (entity fields and actor values to drive the code with)",
      "Add `fixtures: { entity: …, actors: … }` to the spec (docs/behavior-format.md, fixtures).",
    );
  }

  // 1. Candidate transitions: linked, with invocation + storage, a persistence with fakes.
  const candidates: { spec: Transition; code: Transition; sites: CodeSites }[] = [];
  for (const t of [...spec.transitions].sort((a, b) => compareStrings(a.name, b.name))) {
    const skip = (message: string) =>
      skipped.push(
        skipFinding(
          behavior,
          t.name,
          `tsverify test generated no tests for \`${t.name}\`: ${message}`,
          {
            transition: t.name,
            ...(t.at ? { specAt: t.at } : {}),
          },
        ),
      );
    if (t.impl === undefined) {
      skip("it has no `impl`");
      continue;
    }
    const c = code.transitions.find((x) => x.name === t.name && x.sites?.specTransition === t.name);
    const sites = c?.sites;
    if (c === undefined || sites === undefined) {
      skip(`the extractor found no write of \`${t.to}\` reached from ${formatSymbolRef(t.impl)}`);
      continue;
    }
    if (!FAKED.has(sites.persistence)) {
      skip(
        sites.persistence === "memory"
          ? "`memory` persistence has no fakes or replay support yet"
          : `\`${sites.persistence}\` persistence has no fakes yet (only \`assign\` and \`prisma\`)`,
      );
      continue;
    }
    if (sites.invocation === undefined) {
      skip(
        `the extractor could not tell how to call ${formatSymbolRef(t.impl)} (no invocation shape)`,
      );
      continue;
    }
    if (sites.storage === undefined) {
      skip("the extractor could not tell where the entity is stored (no storage site)");
      continue;
    }
    candidates.push({ spec: t, code: c, sites });
  }

  const first = candidates[0]?.sites.storage;
  if (first === undefined) return { skipped };
  const storage: Storage = { ...first };
  const id = fixtures.entity[storage.key];
  if (typeof id !== "string" && typeof id !== "number") {
    skipped.push(
      skipFinding(
        behavior,
        "fixtures",
        `tsverify test generated no tests: \`fixtures.entity\` has no string or number \`${storage.key}\` (the key of the stored ${spec.entity.name})`,
      ),
    );
    return { skipped };
  }

  // 2. Invocation per candidate, acting as the first permitted actor that has a fixture.
  const linked = new Map<string, Linked>();
  for (const { spec: t, code: c, sites } of candidates) {
    const invocation = sites.invocation as InvocationShape;
    const skip = (message: string, hint?: string) =>
      skipped.push(
        skipFinding(
          behavior,
          t.name,
          `tsverify test generated no tests for \`${t.name}\`: ${message}`,
          {
            transition: t.name,
            ...(t.at ? { specAt: t.at } : {}),
            ...(hint === undefined ? {} : { hint }),
          },
        ),
      );
    const s = sites.storage as Storage;
    if (
      s.client !== storage.client ||
      s.collection !== storage.collection ||
      s.key !== storage.key
    ) {
      skip(
        `it stores the entity in ${s.client}.${s.collection} (key ${s.key}), the other transitions in ${storage.client}.${storage.collection} (key ${storage.key})`,
      );
      continue;
    }
    const fixtureArgs = Object.hasOwn(fixtures.args, t.name) ? fixtures.args[t.name] : undefined;
    const takesActor =
      invocation.actor !== undefined ||
      (fixtureArgs !== undefined && mentions(fixtureArgs, "$actor"));
    const actor = takesActor ? t.by.find((a) => Object.hasOwn(fixtures.actors, a)) : undefined;
    if (takesActor && actor === undefined) {
      skip(
        `${formatSymbolRef(invocation.impl)} takes an actor, but none of the actors allowed to perform it (${t.by.join(", ")}) has a fixture`,
        `Add a value for one of them under \`fixtures.actors\`.`,
      );
      continue;
    }
    const built = buildArgs(invocation, fixtureArgs, actor);
    if (!built.ok) {
      skip(built.reason);
      continue;
    }
    linked.set(t.name, {
      spec: t,
      code: c,
      sites,
      invocation,
      ...(fixtureArgs === undefined ? {} : { fixtureArgs }),
      takesActor,
      ...(actor === undefined ? {} : { actor }),
      args: built.args,
    });
  }

  // 3. Fakes, from every code transition's sites (linked or not), like the runtime's
  //    storeConfigFromCode / effectsConfigFromCode (test/runtime-cross-check.test.ts).
  const allSites = code.transitions.flatMap((t) => (t.sites ? [t.sites] : []));
  const storeClients = sortedUnique(allSites.flatMap((s) => (s.storage ? [s.storage.client] : [])));
  const stores: StoreFakeConfig[] = [];
  const prismas: PrismaFakeConfig[] = [];
  for (const client of storeClients) {
    const paths = (pick: (s: CodeSites) => { client: string; path: string } | undefined) =>
      sortedUnique(
        allSites.flatMap((s) => {
          const site = pick(s);
          return site?.client === client ? [site.path] : [];
        }),
      );
    const kind = allSites.find((s) => s.storage?.client === client)?.persistence;
    if (kind === "prisma") {
      const models: Record<string, { key: string }> = {};
      for (const s of allSites) {
        if (s.storage?.client === client) models[s.storage.collection] = { key: s.storage.key };
      }
      const read = paths((s) => s.read);
      const write = paths((s) => s.commit);
      for (const path of [...read, ...write]) models[path.split(".")[0] ?? ""] ??= { key: "id" };
      prismas.push({ client, models: sortKeys(models), read, write });
      continue;
    }
    const collections: Record<string, { key: string }> = {};
    for (const s of allSites) {
      if (s.storage?.client === client) collections[s.storage.collection] = { key: s.storage.key };
    }
    const transactions = sortedUnique(
      allSites.flatMap((s) =>
        s.atomic?.kind === "transaction" && s.atomic.gate?.startsWith(`${client}.`)
          ? [s.atomic.gate.slice(client.length + 1)]
          : [],
      ),
    );
    if (transactions.length > 1) {
      skipped.push(
        skipFinding(
          behavior,
          "fakes",
          `tsverify test generated no tests: client \`${client}\` opens transactions through several methods (${transactions.join(", ")}); the store fake supports one`,
        ),
      );
      return { skipped };
    }
    const config: StoreFakeConfig = {
      client,
      collections: sortKeys(collections),
      read: paths((s) => s.read),
      commit: paths((s) => s.commit),
    };
    if (transactions[0] !== undefined) config.transaction = transactions[0];
    stores.push(config);
  }
  const effects: EffectsFakeConfig[] = Object.keys(spec.bindings.clients)
    .filter((client) => !storeClients.includes(client))
    .sort(compareStrings)
    .map((client) => ({
      client,
      calls: sortedUnique([
        ...allSites.flatMap((s) => s.effects.filter((e) => e.client === client).map((e) => e.path)),
        // A gate equal to the client name: the client export is the function called (path "").
        ...Object.values(spec.bindings.effects)
          .filter((gate) => gate === client || gate.startsWith(`${client}.`))
          .map((gate) => gate.slice(client.length + 1)),
      ]),
    }));

  return {
    ctx: {
      spec,
      code,
      outDir,
      specFile: spec.file ?? `${behavior}.behavior.yaml`,
      behavior,
      fixtures,
      storage,
      id,
      stores,
      prismas,
      effects,
      linked,
    },
    skipped,
  };
}

/** The gate label of a spec effect (`bindings.effects`, or the name itself). */
export function effectGate(ctx: Context, effect: string): string {
  return ctx.spec.bindings.effects[effect] ?? effect;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareStrings(a, b)));
}
