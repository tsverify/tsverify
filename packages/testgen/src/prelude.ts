/**
 * The part every generated test file shares (doc: packages/runtime/DESIGN.md, "Shape of a
 * generated replay test"):
 *
 * 1. fakes as plain top-level consts (a `vi.mock` factory runs lazily, after them)
 * 2. one `vi.mock` per client module (`bindings.clients`), relative to the generated file
 * 3. the impls, imported dynamically after (1); a static import would break the mock factories
 * 4. the fixtures: `ID`, `ENTITY`, `ACTORS`
 */
import { compareStrings, formatSymbolRef, type SymbolRef } from "@tsverify/ir";
import type { Context } from "./context";
import { type HeaderInput, headerLines, literal, Names, propertyKey, relativeImport } from "./emit";
import { ACTORS, ID } from "./invoke";

export const SCHEDULER = "s";
export const ENTITY = "ENTITY";

export interface PreludeOptions {
  header: HeaderInput;
  /** Named imports from `@tsverify/runtime` besides `instrument` and `scheduler` (sorted on output). */
  runtime: string[];
  /** Extra lines after the vitest / runtime imports (e.g. a JSON sidecar import). */
  imports?: string[];
  /** Extra lines after the imports (e.g. a `declare module "vitest"` block). */
  declarations?: string[];
  /** Impls the file calls. */
  impls: SymbolRef[];
  /** Names the rest of the file defines (helpers), so fakes and impls avoid them. */
  reserved: string[];
}

export interface Prelude {
  lines: string[];
  /** Binding name per client (`bindings.clients` key). */
  clients: Map<string, string>;
  /** Call expression per impl (`file#symbol`). */
  impls: Map<string, string>;
  /** The store fake's binding name for the entity's storage client. */
  store: string;
}

export function prelude(ctx: Context, options: PreludeOptions): Prelude {
  const names = new Names([
    SCHEDULER,
    ENTITY,
    ID,
    ACTORS,
    "expect",
    "test",
    "vi",
    "instrument",
    "scheduler",
    ...options.runtime.map((r) => r.replace(/^type /, "")),
    ...options.reserved,
  ]);
  const lines: string[] = [...headerLines(options.header)];

  const bare = (r: string) => r.replace(/^type /, "");
  const runtime = ["instrument", "scheduler", ...options.runtime].sort(
    (a, b) =>
      compareStrings(bare(a).toLowerCase(), bare(b).toLowerCase()) ||
      compareStrings(bare(a), bare(b)),
  );
  lines.push(`import { expect, test, vi } from "vitest";`);
  lines.push(
    runtime.length <= 3
      ? `import { ${runtime.join(", ")} } from "@tsverify/runtime";`
      : ["import {", ...runtime.map((r) => `  ${r},`), `} from "@tsverify/runtime";`].join("\n"),
  );
  lines.push(...(options.imports ?? []));
  if (options.declarations) lines.push("", ...options.declarations);

  // (1) fakes
  const clients = new Map<string, string>();
  lines.push(
    "",
    "// (1) Fakes as plain top-level consts (vi.mock is hoisted, but its factory runs lazily).",
  );
  lines.push(`const ${SCHEDULER} = scheduler();`);
  for (const store of ctx.stores) {
    const name = names.allocate(store.client);
    clients.set(store.client, name);
    const collections = Object.entries(store.collections)
      .map(([c, { key }]) => `${propertyKey(c)}: { key: ${JSON.stringify(key)} }`)
      .join(", ");
    lines.push(`const ${name} = instrument.store(${SCHEDULER}, {`);
    lines.push(`  client: ${JSON.stringify(store.client)},`);
    lines.push(`  collections: { ${collections} },`);
    lines.push(`  read: ${literal(store.read)},`);
    lines.push(`  commit: ${literal(store.commit)},`);
    if (store.transaction !== undefined) {
      lines.push(`  transaction: ${JSON.stringify(store.transaction)},`);
    }
    lines.push("});");
  }
  for (const fake of ctx.prismas) {
    const name = names.allocate(fake.client);
    clients.set(fake.client, name);
    const models = Object.entries(fake.models)
      .map(([m, { key }]) => `${propertyKey(m)}: { key: ${JSON.stringify(key)} }`)
      .join(", ");
    lines.push(`const ${name} = instrument.prisma(${SCHEDULER}, {`);
    lines.push(`  client: ${JSON.stringify(fake.client)},`);
    lines.push(`  models: { ${models} },`);
    lines.push(`  read: ${literal(fake.read)},`);
    lines.push(`  write: ${literal(fake.write)},`);
    lines.push("});");
  }
  for (const fake of ctx.effects) {
    const name = names.allocate(fake.client);
    clients.set(fake.client, name);
    lines.push(
      `const ${name} = instrument.effects(${SCHEDULER}, { client: ${JSON.stringify(fake.client)}, calls: ${literal(fake.calls)} });`,
    );
  }

  // (2) client modules
  const outDir = ctx.outDir;
  const byModule = new Map<string, { exportName: string; fake: string }[]>();
  for (const [client, binding] of Object.entries(ctx.spec.bindings.clients)) {
    const fake = clients.get(client);
    if (fake === undefined) continue;
    const list = byModule.get(binding.module) ?? [];
    list.push({ exportName: binding.export, fake });
    byModule.set(binding.module, list);
  }
  lines.push(
    "",
    "// (2) The modules that construct the clients (bindings.clients), relative to this file.",
  );
  for (const module of [...byModule.keys()].sort(compareStrings)) {
    const exports = (byModule.get(module) ?? [])
      .sort((a, b) => compareStrings(a.exportName, b.exportName))
      .map((e) => `${propertyKey(e.exportName)}: ${e.fake}.client`)
      .join(", ");
    lines.push(
      `vi.mock(${JSON.stringify(relativeImport(outDir, module))}, () => ({ ${exports} }));`,
    );
  }

  // (3) impls
  const impls = new Map<string, string>();
  const byFile = new Map<string, SymbolRef[]>();
  for (const impl of options.impls) {
    const list = byFile.get(impl.file) ?? [];
    if (!list.some((i) => i.symbol === impl.symbol)) list.push(impl);
    byFile.set(impl.file, list);
  }
  lines.push("", "// (3) The impls, imported dynamically after (1).");
  for (const file of [...byFile.keys()].sort(compareStrings)) {
    const bindings: string[] = [];
    const heads = new Map<string, string>();
    for (const impl of (byFile.get(file) ?? []).sort((a, b) =>
      compareStrings(a.symbol, b.symbol),
    )) {
      const [head = impl.symbol, ...rest] = impl.symbol.split(".");
      let local = heads.get(head);
      if (local === undefined) {
        local = names.allocate(head);
        heads.set(head, local);
        bindings.push(local === head ? head : `${propertyKey(head)}: ${local}`);
      }
      impls.set(formatSymbolRef(impl), [local, ...rest].join("."));
    }
    lines.push(
      `const { ${bindings.join(", ")} } = await import(${JSON.stringify(relativeImport(outDir, file))});`,
    );
  }

  // (4) fixtures
  lines.push("", "// (4) Fixtures (the spec's `fixtures`).");
  lines.push(`const ${ID} = ${literal(ctx.id)};`);
  lines.push(`const ${ENTITY} = ${literal(ctx.fixtures.entity)};`);
  const actors = Object.entries(ctx.fixtures.actors);
  if (actors.length > 0) {
    lines.push(`const ${ACTORS} = {`);
    for (const [name, value] of actors) lines.push(`  ${propertyKey(name)}: ${literal(value)},`);
    lines.push("};");
  }

  const store = clients.get(ctx.storage.client);
  if (store === undefined) throw new Error(`testgen: no fake for client ${ctx.storage.client}`);
  return { lines, clients, impls, store };
}
