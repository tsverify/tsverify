/**
 * `extractAll`: one TypeScript program per project, every spec extracted against it.
 *
 * 0. Install the project's TypeScript 7 (`typescript.ts`): the caller's, or `loadTypeScript`'s.
 * 1. Load the tsconfig's files (`project.ts`), in a compiler process that is closed before
 *    `extractAll` returns or throws.
 * 2. Syntax only: candidate state writes for every spec's state field (`writes.ts`).
 * 3. Plan every narrowing probe (`type-facts.ts`, X1 probe-first) — still no type query.
 * 4. Type queries: entity matching, from-states, link resolution, call graph, guards, effects,
 *    persistence facts; then model assembly (`assemble.ts`).
 *
 * **Whose writes.** The program can hold files of other packages (a workspace package resolved
 * to its sources through `paths` or `customConditions`). Only the project's own files
 * (`ProjectContext.isOwnFile`: under the project root, or named by the tsconfig's own `files` /
 * `include`) are searched for writes nobody asked about; a write in another file counts only
 * where an `impl` reaches it. So a package's forwarding wrappers (`startAttempt(…) { return
 * this.inner.startAttempt(…) }`) are not reported as `undeclared-transition`.
 */
import type {
  BehaviorModel,
  Finding,
  PersistenceKind,
  SourceLocation,
  StorageArg,
  StorageFunction,
  StorageRole,
  UnreadWrite,
} from "@tsverify/ir";
import {
  compareStrings,
  formatStorageArg,
  formatSymbolRef,
  shortLocation,
  storageFunctions,
} from "@tsverify/ir";
import { assignAdapter } from "./adapters/assign";
import {
  type BoundFunction,
  functionsAdapter,
  STORAGE_CLIENT,
  StorageFunctions,
  type UpdateCheck,
} from "./adapters/functions";
import { memoryAdapter } from "./adapters/memory";
import { prismaAdapter } from "./adapters/prisma";
import type { PersistenceAdapter, PersistenceFacts } from "./adapters/types";
import { assemble, type Draft, type MatchedWrite } from "./assemble";
import { Callees, frameCalls, frameNaming, frameOf, type Reach, reach } from "./callgraph";
import type { FunctionLike } from "./cfg";
import { ClientCalls } from "./client-calls";
import { primaryDeclarationOf } from "./declarations";
import { Dominance, type GuardMiss } from "./dominance";
import { matchesEntity, writtenValue } from "./entity";
import {
  brokenLink,
  mergeSharedWrites,
  sortFindings,
  spokenNames,
  unanalyzable,
  uniqueIds,
} from "./findings";
import { guardArgs } from "./guard-args";
import { loadTypeScript, TypeScriptSetupError } from "./load-typescript";
import { type LoadedProject, loadProject, ProjectContext } from "./project";
import {
  functionOfDeclaration,
  isExportedPath,
  isInstanceMember,
  pathHeadKind,
  pathHeadMembers,
  resolveClient,
  resolveGuard,
  resolveImpl,
  resolveStorageFunction,
  symbolOf,
} from "./resolve";
import type * as TS from "./ts-types";
import {
  declaredFieldType,
  declaredTypeOfRef,
  literalsOf,
  type Narrowed,
  type NarrowHandle,
  type NarrowRequest,
  typeNames,
  withMembershipGuards,
} from "./type-facts";
import { type TypeScript, ts, useTypeScript } from "./typescript";
import {
  findCandidateWrites,
  findUpdateProbes,
  oneLine,
  type PatchOptions,
  rebindWrites,
  type WriteNode,
} from "./writes";

export interface ExtractOptions {
  /** Project root; `impl` and binding paths are relative to it. */
  projectRoot: string;
  /** tsconfig path, relative to `projectRoot`. Default `<projectRoot>/tsconfig.json`. */
  tsconfig?: string;
  /**
   * The TypeScript to read the code with (7.0 or later). Default: `loadTypeScript(projectRoot)`;
   * `extractAll` throws its error (`TypeScriptSetupError`) when none is usable.
   */
  typescript?: TypeScript;
}

export interface ExtractResult {
  /** The spec model's `name`. */
  spec: string;
  model?: BehaviorModel;
  findings: Finding[];
}

export interface ExtractAllResult {
  /** One per spec, in order. */
  results: ExtractResult[];
  stats: ExtractStats;
  /**
   * The project tsconfig's `customConditions`, when it sets any: the package `exports`
   * conditions its imports resolve with (generated tests resolve with them too).
   */
  customConditions?: string[];
}

export interface ExtractStats {
  /** Source files analyzed (project files, no declarations, no `node_modules`). */
  files: number;
  /** Candidate state writes found syntactically (all state fields, before entity matching). */
  writes: number;
  /** Narrowing probes injected. */
  probes: number;
  durationMs: number;
}

/** Type facts of one candidate write; `narrowed.values` is `*` when it could not be probed. */
interface WriteTypes {
  narrowed: Narrowed;
  probed: boolean;
}

interface Env {
  ctx: ProjectContext;
  writes: WriteNode[];
  types: WriteTypes[];
  callees: Callees;
  /** The probe at a blind update's call (`findUpdateProbes`), for the `functions` adapter. */
  narrowAtCall: (call: TS.CallExpression, field: string) => UpdateCheck | undefined;
}

function now(): number {
  return globalThis.performance.now();
}

/** Imports `PrismaClient` by name (from a custom generator output such as `./generated/prisma`). */
function importsPrismaClient(st: TS.ImportDeclaration): boolean {
  const bindings = st.importClause?.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some((e) => (e.propertyName ?? e.name).text === "PrismaClient")
  );
}

/**
 * `bindings.persistence` when omitted: `prisma` for an `@prisma/*` import or any import of
 * `PrismaClient` (custom generator outputs), `drizzle` for a `drizzle-orm` import, else `assign`.
 */
function detectPersistence(ctx: ProjectContext): PersistenceKind {
  let prismaClient = false;
  for (const sf of ctx.analyzedFiles()) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const m = st.moduleSpecifier.text;
      if (m === "@prisma/client" || m.startsWith("@prisma/")) return "prisma";
      if (m === "drizzle-orm" || m.startsWith("drizzle-orm/")) return "drizzle";
      prismaClient ||= importsPrismaClient(st);
    }
  }
  return prismaClient ? "prisma" : "assign";
}

const ADAPTERS: Partial<Record<PersistenceKind, PersistenceAdapter>> = {
  assign: assignAdapter,
  memory: memoryAdapter,
  prisma: prismaAdapter,
};

function unprobedTypes(write: WriteNode, checker: TS.Checker): Narrowed {
  const fieldType = declaredFieldType(write.ref, write.field, checker);
  return {
    values: "*",
    declared: fieldType ? literalsOf(fieldType, checker) : "*",
    unconstrained: false,
    typeText: "unknown",
    declaredText: fieldType ? checker.typeToString(fieldType) : "unknown",
    refTypeNames: typeNames(declaredTypeOfRef(write.ref, checker), checker),
  };
}

/** Whether a storage argument gives a field (not the argument itself) the `patch` or `entity` role. */
function hasFieldPatch(arg: StorageArg): boolean {
  if (typeof arg === "string") return false;
  return Object.values(arg).some(
    (inner) => inner === "patch" || inner === "entity" || hasFieldPatch(inner),
  );
}

/**
 * `patch` write discovery and blind-update probes (`writes.ts`), only when some spec names its
 * own storage functions.
 */
function patchOptions(specs: readonly BehaviorModel[]): PatchOptions | undefined {
  const named = specs.filter((s) => s.bindings.storage !== undefined);
  if (named.length === 0) return undefined;
  const fieldPatchNames = new Set<string>();
  const blindUpdates: { symbol: string; field: string }[] = [];
  for (const spec of named) {
    const b = spec.bindings.storage as NonNullable<typeof spec.bindings.storage>;
    for (const f of [...b.save, ...b.update]) {
      if (f.args.some(hasFieldPatch)) {
        fieldPatchNames.add(f.ref.symbol.slice(f.ref.symbol.lastIndexOf(".") + 1));
      }
    }
    for (const f of b.update) {
      if (f.from && spec.entity.states.every((st) => f.from?.includes(st))) {
        blindUpdates.push({ symbol: f.ref.symbol, field: spec.entity.stateField });
      }
    }
  }
  return {
    fields: new Set(named.map((s) => s.entity.stateField)),
    readSymbols: named.flatMap((s) => s.bindings.storage?.read.map((f) => f.ref.symbol) ?? []),
    ...(fieldPatchNames.size > 0 ? { fieldPatchNames } : {}),
    ...(blindUpdates.length > 0 ? { blindUpdates } : {}),
  };
}

function requireTypeScript(projectRoot: string): TypeScript {
  const loaded = loadTypeScript(projectRoot);
  if ("error" in loaded) throw new TypeScriptSetupError(loaded.error);
  return loaded.ts;
}

/**
 * Extracts the code model of every spec from one TypeScript project. Throws
 * `TypeScriptSetupError` when the project cannot be read as set up (no TypeScript 7, a tsconfig
 * TypeScript rejects).
 */
export function extractAll(specs: BehaviorModel[], options: ExtractOptions): ExtractAllResult {
  const start = now();
  useTypeScript(options.typescript ?? requireTypeScript(options.projectRoot));
  const loaded = loadProject(options.projectRoot, options.tsconfig);
  if ("error" in loaded) {
    const results = specs.map((spec) => ({
      spec: spec.name,
      findings: [
        brokenLink(
          spec.name,
          "tsconfig",
          undefined,
          `cannot load the TypeScript project: ${loaded.error}, so the code behind \`impl\` and \`bindings\` can't be located`,
          spec.file === undefined ? undefined : { file: spec.file, line: 1, column: 1 },
          {
            hint: "Pass the project root that contains tsconfig.json, or set the tsconfig path.",
          },
        ),
      ],
    }));
    return { results, stats: { files: 0, writes: 0, probes: 0, durationMs: now() - start } };
  }
  try {
    return extractLoaded(specs, loaded, start);
  } finally {
    loaded.close();
  }
}

function extractLoaded(
  specs: BehaviorModel[],
  loaded: LoadedProject,
  start: number,
): ExtractAllResult {
  // Phase 1 (syntax) and probe planning: no type query before planNarrowing.
  const fields = new Set(specs.map((s) => s.entity.stateField));
  const patch = patchOptions(specs);
  const candidates = findCandidateWrites(loaded.files, fields, patch);
  const requests: NarrowRequest[] = [];
  const requestOf: (number | undefined)[] = [];
  for (const c of candidates) {
    if (c.ref === undefined) {
      requestOf.push(undefined);
      continue;
    }
    requestOf.push(requests.length);
    requests.push({ file: c.file, span: c.span, ref: c.ref, field: c.field });
  }
  // Probes at blind updates: the state the code checked before each (`findUpdateProbes`).
  const updateProbes = findUpdateProbes(loaded.files, patch);
  const updateRequest = new Map<string, number[]>();
  for (const u of updateProbes) {
    const key = `${u.file}:${u.span.start}`;
    updateRequest.set(key, [...(updateRequest.get(key) ?? []), requests.length]);
    requests.push({ file: u.file, span: u.span, ref: u.ref, field: u.field });
  }
  const handles = loaded.facts.planNarrowing(requests);

  // Phase 2: type queries.
  const ctx = new ProjectContext(loaded);
  const writes = rebindWrites(
    candidates,
    fields,
    (f) => ctx.sourceFile(f),
    (f, o) => ctx.facts.toOriginalPosition(f, o),
    patch,
  );
  const types: WriteTypes[] = writes.map((w, i) => {
    const r = requestOf[i];
    if (r === undefined) return { narrowed: unprobedTypes(w, ctx.checker), probed: false };
    const narrowed = ctx.facts.narrowedLiteralsAt(handles[r] as NarrowHandle);
    // X1 L9: `.includes` / `.has` guards, which TS does not narrow through.
    return {
      narrowed: withMembershipGuards(narrowed, w.expr, w.ref, w.field, ctx.checker),
      probed: true,
    };
  });
  const narrowAtCall = (call: TS.CallExpression, field: string): UpdateCheck | undefined => {
    const file = call.getSourceFile().fileName;
    const start = ctx.facts.toOriginalPosition(file, call.getStart());
    for (const r of updateRequest.get(`${file}:${start}`) ?? []) {
      if (requests[r]?.field !== field) continue;
      // The probe wraps the call: `(order.status, update(…))`; several probes at one call nest.
      const want = `${requests[r]?.ref}.${field}`;
      let probe: TS.PropertyAccessExpression | undefined;
      for (let c: TS.Node = call; !probe; ) {
        const p = c.parent;
        if (ts.isParenthesizedExpression(p)) c = p;
        else if (
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.CommaToken &&
          p.right === c
        ) {
          if (ts.isPropertyAccessExpression(p.left) && p.left.getText() === want) probe = p.left;
          c = p;
        } else break;
      }
      if (!probe) continue;
      const ref = probe.expression;
      const narrowed = ctx.facts.narrowedLiteralsAt(handles[r] as NarrowHandle);
      return {
        ref,
        narrowed: withMembershipGuards(narrowed, call, ref, field, ctx.checker),
      };
    }
    return undefined;
  };
  const env: Env = { ctx, writes, types, callees: new Callees(ctx), narrowAtCall };
  const results = specs.map((spec) => extractSpec(spec, env));
  return {
    results,
    ...(loaded.customConditions ? { customConditions: loaded.customConditions } : {}),
    stats: {
      files: loaded.files.length,
      writes: candidates.length,
      probes: requests.length,
      durationMs: now() - start,
    },
  };
}

/** How many unbound methods the `storage.unbound-methods` finding names before "and N more". */
const MAX_LISTED = 12;

/**
 * Calls the impls make (anywhere in their reach) to a method in `siblings`, one per method, at its
 * first call (in impl order, then reach and source order), sorted by name.
 */
function unboundSiblingCalls(
  ctx: ProjectContext,
  siblings: ReadonlyMap<TS.Symbol, string>,
  impls: readonly { reach: Reach }[],
): { name: string; at: SourceLocation }[] {
  if (siblings.size === 0) return [];
  const first = new Map<string, SourceLocation>();
  const seen = new Set<FunctionLike>();
  for (const { reach } of impls) {
    for (const frame of reach.frames) {
      if (seen.has(frame)) continue;
      seen.add(frame);
      for (const call of frameCalls(frame)) {
        const sym = symbolOf(call.expression, ctx.checker);
        const name = sym && siblings.get(sym);
        if (name !== undefined && !first.has(name)) first.set(name, ctx.loc(call));
      }
    }
  }
  return [...first]
    .map(([name, at]) => ({ name, at }))
    .sort((a, b) => compareStrings(a.name, b.name));
}

/** A file's name without directory and extension: the subject of findings outside any function. */
function moduleName(ctx: ProjectContext, node: TS.Node): string {
  const rel = ctx.rel(node.getSourceFile().fileName);
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[cm]?[jt]sx?$/, "");
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => compareStrings(a, b));
}

function extractSpec(spec: BehaviorModel, env: Env): ExtractResult {
  const { ctx, callees } = env;
  const checker = ctx.checker;
  const findings: Finding[] = [];
  const behavior = spec.name;

  const storageBinding = spec.bindings.storage;
  const kind: PersistenceKind = storageBinding
    ? "functions"
    : (spec.bindings.persistence ?? detectPersistence(ctx));
  // Named storage functions: resolved by symbol, for the `functions` adapter.
  let storage: StorageFunctions | undefined;
  // Bindings `tsverify test` can't replace with a fake (`BehaviorModel.unfakeable`).
  const unfakeable: { binding: string; reason: string }[] = [];
  // Methods of the interfaces, classes and objects some `bindings.storage` functions belong to
  // (`RunStore` of `RunStore.findRun`), with their names, minus the bound ones (below).
  const siblings = new Map<TS.Symbol, string>();
  if (storageBinding) {
    const bound = new Map<TS.Symbol, BoundFunction>();
    for (const { fn } of storageFunctions(storageBinding)) {
      const owner = pathHeadMembers(ctx, fn.ref);
      for (const [sym, name] of owner?.members ?? []) siblings.set(sym, `${owner?.head}.${name}`);
    }
    for (const { kind: fnKind, fn } of storageFunctions(storageBinding)) {
      const r = resolveStorageFunction(ctx, fn);
      const head = fn.ref.symbol.split(".")[0] as string;
      const headKind = r.ok && fn.ref.symbol.includes(".") ? pathHeadKind(ctx, fn.ref) : undefined;
      if (headKind !== undefined) {
        unfakeable.push({
          binding: `storage.${fn.ref.symbol}`,
          reason:
            headKind === "type"
              ? `${fn.ref.symbol} is a method of ${head}, a type, which has no value to replace`
              : `${fn.ref.symbol} is a method of the class ${head}, which would have to be replaced as a whole`,
        });
      }
      if (r.ok) {
        bound.set(r.value, { kind: fnKind, fn, path: fn.ref.symbol });
        siblings.delete(r.value);
        const issue = roleArgumentIssue(ctx, r.value, fn, storageBinding.key);
        if (issue) {
          const at = fn.at ?? storageBinding.at;
          findings.push({
            ...unanalyzable(
              behavior,
              "binding",
              `${STORAGE_CLIENT}.${fn.ref.symbol}.args`,
              `argument ${issue.index + 1} of storage ${fnKind} function ${formatSymbolRef(fn.ref)} ${issue.message}`,
              { hint: issue.hint },
            ),
            ...(at ? { specAt: at } : {}),
          });
        }
        // Read as bound by `check`, like a private impl (`hiddenImpls`); but generated tests
        // replace storage functions by mocking the module that exports them.
        if (!isExportedPath(ctx, fn.ref)) {
          unfakeable.push({
            binding: `storage.${fn.ref.symbol}`,
            reason: `storage ${fnKind} function ${formatSymbolRef(fn.ref)} is not exported, and the tests replace a storage function by mocking the module that exports it (export ${head} from ${fn.ref.file} and keep the impls that call it in another module, or bind the exported function that calls it)`,
          });
        }
      } else {
        findings.push(
          brokenLink(
            behavior,
            "storage",
            fn.ref.symbol,
            `storage ${fnKind} function ${formatSymbolRef(fn.ref)} does not resolve: ${r.reason}`,
            fn.at ?? storageBinding.at,
            {
              hint: "Point `bindings.storage` at `path#function` (or `path#object.method`), relative to the project root.",
            },
          ),
        );
      }
    }
    storage = new StorageFunctions(checker, bound);
  }
  const adapter =
    storageBinding && storage
      ? functionsAdapter({
          binding: storageBinding,
          fns: storage,
          callees,
          checker,
          entity: spec.entity,
          narrowAt: (call) => env.narrowAtCall(call, spec.entity.stateField),
        })
      : ADAPTERS[kind];
  if (!adapter) {
    findings.push(
      unanalyzable(
        behavior,
        "persistence",
        kind,
        `persistence "${kind}" is not supported yet; no code model was extracted`,
        {
          hint: "Name the app's own storage functions in `bindings.storage` (`read`, `save`, `update`, `atomic`), which works whatever database is underneath (docs/authoring-guide.md §7.6). The presets are `assign` (repository objects on a bound client), `prisma` and `memory`.",
        },
      ),
    );
    return { spec: behavior, findings };
  }

  // Links: clients, guards, impls.
  const clientSyms = new Map<TS.Symbol, string>();
  for (const [name, binding] of sortedEntries(spec.bindings.clients)) {
    const r = resolveClient(ctx, binding);
    if (r.ok) {
      clientSyms.set(r.value, name);
      if (r.value.flags & ts.SymbolFlags.Class) {
        unfakeable.push({
          binding: `clients.${name}`,
          reason: `client ${name} is the class ${binding.export}, and a fake object in its place would break \`new ${binding.export}(…)\``,
        });
      } else if (!(r.value.flags & ts.SymbolFlags.Value)) {
        const what = r.value.flags & ts.SymbolFlags.Interface ? "the interface" : "the type";
        unfakeable.push({
          binding: `clients.${name}`,
          reason: `client ${name} is ${what} ${binding.export}, a type: there is no module export to replace with a fake, and the code gets its instances from elsewhere`,
        });
      }
    } else {
      findings.push(
        brokenLink(
          behavior,
          "client",
          name,
          `client "${name}" (${binding.module}#${binding.export}) does not resolve: ${r.reason}`,
          binding.at,
          {
            hint: "Point `bindings.clients` at the module (relative to the project root) and the exported name of the client value.",
          },
        ),
      );
    }
  }
  const guards: { key: string; sym: TS.Symbol; args: string[] }[] = [];
  for (const [key, binding] of sortedEntries(spec.bindings.guards)) {
    const r = resolveGuard(ctx, binding);
    if (r.ok) guards.push({ key, sym: r.value, args: binding.args });
    else {
      findings.push(
        brokenLink(
          behavior,
          "guard",
          key,
          `guard "${key}" (${binding.raw}) does not resolve: ${r.reason}`,
          binding.at,
          {
            hint: "Point `bindings.guards` at `path#function` or `path#function(args)`, relative to the project root.",
          },
        ),
      );
    }
  }
  const reads = new Map<string, readonly string[]>();
  for (const [name, binding] of Object.entries(spec.bindings.clients)) {
    if (binding.reads && binding.reads.length > 0) reads.set(name, binding.reads);
  }
  const calls = new ClientCalls(
    checker,
    clientSyms,
    adapter,
    storage && ((call) => storage.clientCall(call)),
    reads,
  );
  const guardSyms = new Set(guards.map((g) => g.sym));
  const calleeSym = (call: TS.CallExpression) => symbolOf(call.expression, checker);
  const argsMatch = (g: (typeof guards)[number], lits: readonly string[]) =>
    g.args.length === lits.length && g.args.every((a, i) => a === lits[i]);
  const match = (call: TS.CallExpression): string[] => {
    const sym = calleeSym(call);
    if (!sym || !guardSyms.has(sym)) return [];
    const lits = guardArgs(call, checker);
    return guards.filter((g) => g.sym === sym && argsMatch(g, lits)).map((g) => g.key);
  };
  // A call of a guard's function whose literal arguments differ from the binding's.
  const miss = (call: TS.CallExpression): GuardMiss[] => {
    const sym = calleeSym(call);
    if (!sym || !guardSyms.has(sym)) return [];
    const lits = guardArgs(call, checker);
    return guards
      .filter((g) => g.sym === sym && !argsMatch(g, lits))
      .map((g) => ({ key: g.key, args: lits }));
  };
  const isStop = (call: TS.CallExpression): boolean => {
    if (calls.classify(call)) return true;
    const sym = calleeSym(call);
    return sym !== undefined && guardSyms.has(sym);
  };
  const dominance = new Dominance(
    callees,
    isStop,
    match,
    guards.map((g) => g.key),
    miss,
  );

  const reachMemo = new Map<FunctionLike, Reach>();
  const reachFrom = (fn: FunctionLike): Reach => {
    let r = reachMemo.get(fn);
    if (!r) {
      r = reach(fn, callees, isStop);
      reachMemo.set(fn, r);
    }
    return r;
  };

  const impls: { name: string; fn: FunctionLike; reach: Reach }[] = [];
  const instanceImpls: string[] = [];
  const hiddenImpls: Record<string, string> = {};
  const implAt: Record<string, SourceLocation> = {};
  for (const t of [...spec.transitions].sort((a, b) => compareStrings(a.name, b.name))) {
    if (!t.impl) continue;
    const r = resolveImpl(ctx, t.impl);
    if (r.ok) {
      impls.push({ name: t.name, fn: r.value, reach: reachFrom(r.value) });
      implAt[t.name] = ctx.loc(frameNaming(r.value).node);
      if (isInstanceMember(r.value)) instanceImpls.push(t.name);
      // Read as usual by `check`; a generated test imports and calls it, so `test` can't.
      const head = t.impl.symbol.split(".")[0] as string;
      const privateMember = t.impl.symbol.split(".").find((m) => m.startsWith("#"));
      if (privateMember !== undefined) {
        hiddenImpls[t.name] =
          `its impl ${formatSymbolRef(t.impl)} is a private method (${privateMember}), which code outside its class can't call`;
      } else if (!isExportedPath(ctx, t.impl)) {
        hiddenImpls[t.name] =
          `its impl ${formatSymbolRef(t.impl)} is not exported (${head} is not an export of ${t.impl.file}), so a generated test can't import it`;
      }
    } else {
      findings.push(
        brokenLink(
          behavior,
          "impl",
          t.name,
          `${t.name}: impl ${t.impl.file}#${t.impl.symbol} does not resolve: ${r.reason}`,
          t.at,
          {
            transition: t.name,
            hint: "`impl` is `path#function`, relative to the project root (the directory with tsconfig.json).",
          },
        ),
      );
    }
  }

  const unboundSiblings = unboundSiblingCalls(ctx, siblings, impls);
  if (unboundSiblings.length > 0 && storageBinding) {
    const owners = [...new Set(unboundSiblings.map((u) => u.name.split(".")[0]))];
    const shown = unboundSiblings.slice(0, MAX_LISTED);
    const more = unboundSiblings.length - shown.length;
    const list =
      shown.map((u) => `${u.name} (${shortLocation(u.at)})`).join(", ") +
      (more > 0 ? ` and ${more} more` : "");
    findings.push({
      ...unanalyzable(
        behavior,
        "binding",
        "storage.unbound-methods",
        `the impls call methods of ${owners.join(", ")} that \`bindings.storage\` doesn't bind: ${list}. tsverify doesn't look inside them, so a change of ${spec.entity.name}.${spec.entity.stateField} they make is not seen`,
        {
          codeAt: (unboundSiblings[0] as { at: SourceLocation }).at,
          hint: `If one of them changes ${spec.entity.stateField}, bind it under \`bindings.storage\` (an \`update\` with its \`from\` and \`to\`, or a \`save\`), so tsverify reads it as a write; one that only reads can be bound under \`read\` or left as it is.`,
        },
      ),
      severity: "info",
      ...(storageBinding.at ? { specAt: storageBinding.at } : {}),
    });
  }

  // Writes of this spec's entity.
  const matched: MatchedWrite[] = [];
  // Writes of the entity's state that are reported as unanalyzable and not extracted.
  const unread: { frame: FunctionLike; write: Omit<UnreadWrite, "finding">; finding: Finding }[] =
    [];
  // Writes the adapter finds by symbol (conditional saves) need no probe.
  const extra = adapter.extraWrites?.(ctx.analyzedFiles(), spec.entity) ?? [];
  const writeTypes: WriteTypes[] = extra.map(() => ({
    narrowed: {
      values: "*",
      declared: spec.entity.states,
      unconstrained: false,
      typeText: "unknown",
      declaredText: "unknown",
      refTypeNames: [],
    },
    probed: false,
  }));
  /** A write in a file of another package is the project's only where an impl reaches it. */
  const outside = (write: WriteNode): boolean => {
    if (ctx.isOwnFile(write.expr.getSourceFile())) return false;
    const frame = frameOf(write.expr);
    return frame === undefined || !impls.some((i) => i.reach.frames.includes(frame));
  };
  [...env.writes, ...extra].forEach((write, i) => {
    if (write.field !== spec.entity.stateField || !adapter.writeKinds.has(write.kind)) return;
    if (outside(write)) return;
    const { narrowed, probed } = (env.types[i] ?? writeTypes[i - env.writes.length]) as WriteTypes;
    const decided = adapter.matchEntity?.(write, calls, spec.entity);
    const match =
      decided === undefined
        ? matchesEntity(spec.entity, narrowed.declared, narrowed.refTypeNames)
        : decided && "name";
    if (!match) return;
    const frame = frameOf(write.expr);
    let persistence: PersistenceFacts | undefined;
    const analyze = (fn: FunctionLike): PersistenceFacts => {
      persistence ??= adapter.analyzeWrite({
        write,
        frame: fn,
        frameCalls: frameCalls(fn),
        calls,
        callees,
        checker,
        entity: spec.entity,
      });
      return persistence;
    };
    // The exact-union fallback needs a recognized read: DTOs and events share the union. An
    // object built up before it is saved (`writes.ts`, `held`) is reported, never dropped.
    const builtUp = write.held?.issue !== undefined && write.kind === "assign";
    if (match === "union" && !builtUp && (!frame || !analyze(frame).read)) return;
    const at = ctx.loc(write.site);
    const subject = frame ? frameNaming(frame).name : moduleName(ctx, write.expr);
    const value = write.fixedValue ?? writtenValue(write.value, checker);
    /** Reports a write tsverify sees but can't read as a transition; impls reaching it are unconfirmed. */
    const notExtracted = (property: string, message: string, reason: string, hint: string) => {
      const finding = unanalyzable(behavior, property, subject, message, { codeAt: at, hint });
      findings.push(finding);
      if (!frame) return;
      const fn = frameNaming(frame).name;
      unread.push({
        frame,
        write: { at, function: fn, reason, ...(value === undefined ? {} : { value }) },
        finding,
      });
    };
    // An object held in a variable that tsverify can't follow to the call (`writes.ts`).
    if (write.held?.issue !== undefined) {
      const target = write.call
        ? `, an object later passed to \`${oneLine(write.call.expression)}\``
        : "";
      notExtracted(
        "write-shape",
        `${spec.entity.name}.${write.field} is set in \`${write.held.name}\`${target}, but ${write.held.issue}; the write is not extracted`,
        `${write.field} is set in \`${write.held.name}\`, but ${write.held.issue}`,
        `Write the ${write.field} into the call that saves it, or hold the object in a \`const\` that is only passed to that one call, with the ${write.field} as a literal (docs/authoring-guide.md, "Restructuring unanalyzable code").`,
      );
      return;
    }
    const unreadable = frame && analyze(frame).unreadable;
    if (unreadable) {
      notExtracted(
        "write-shape",
        `${unreadable.message}; the write is not extracted`,
        unreadable.reason,
        unreadable.hint,
      );
      return;
    }
    if (value === undefined) {
      notExtracted(
        "write-value",
        `${spec.entity.name}.${write.field} is assigned a value that is not a single literal (${write.value.getText()}); the write is not extracted`,
        `the value \`${write.value.getText()}\` is not a single literal`,
        "Assign a string literal (or a constant with a literal type) so the target state is known.",
      );
      return;
    }
    if (!frame) {
      findings.push(
        unanalyzable(
          behavior,
          "write-frame",
          moduleName(ctx, write.expr),
          `${spec.entity.name}.${write.field} is written outside any function; the write is not extracted`,
          {
            codeAt: at,
            hint: "Move the write into a function that a spec transition's impl calls.",
          },
        ),
      );
      return;
    }
    matched.push({ write, at, value, narrowed, probed, frame, persistence: analyze(frame) });
  });

  const persistenceClients = new Set<string>(storage ? [STORAGE_CLIENT] : []);
  for (const m of matched) {
    const p = m.persistence;
    if (p.read) persistenceClients.add(p.read.client);
    if (p.commit) persistenceClients.add(p.commit.client);
    if (p.scope) {
      const opener = calls.classify(p.scope.call);
      if (opener) persistenceClients.add(opener.client);
    }
  }

  // Linking: a write reached from an impl belongs to that spec transition. When several impls
  // reach it, the ones whose `to` equals the written state win.
  const drafts: Draft[] = [];
  for (const m of matched) {
    const linkers = impls.filter((i) => i.reach.frames.includes(m.frame));
    const exact = linkers.filter(
      (i) => spec.transitions.find((t) => t.name === i.name)?.to === m.value,
    );
    const use = exact.length > 0 ? exact : linkers;
    if (use.length === 0) {
      drafts.push({ write: m, reach: reachFrom(m.frame) });
      continue;
    }
    for (const l of use) {
      const t = spec.transitions.find((x) => x.name === l.name);
      drafts.push({ write: m, reach: l.reach, linked: t });
    }
  }

  const uncalled = reportUncalled(spec, ctx, calls, clientSyms, storage, findings);

  const model = assemble(spec, drafts, {
    ctx,
    calls,
    dominance,
    persistenceClients,
    persistence: kind,
    adapter,
    findings,
    implAt,
    uncalledClients: new Set(Object.keys(uncalled)),
  });
  if (Object.keys(uncalled).length > 0) model.uncalledClients = uncalled;
  if (instanceImpls.length > 0) model.instanceImpls = instanceImpls;
  if (Object.keys(hiddenImpls).length > 0) model.hiddenImpls = hiddenImpls;
  if (unfakeable.length > 0) model.unfakeable = unfakeable;
  const sorted = sortFindings(uniqueIds(spokenNames(mergeSharedWrites(findings))));
  // After `uniqueIds`: each unread write names its finding by its final id.
  const unreadWrites: Record<string, UnreadWrite[]> = {};
  for (const impl of impls) {
    const reached = unread
      .filter((u) => impl.reach.frames.includes(u.frame))
      .map((u) => ({ ...u.write, finding: u.finding.id }));
    if (reached.length > 0) unreadWrites[impl.name] = reached;
  }
  if (Object.keys(unreadWrites).length > 0) model.unreadWrites = unreadWrites;
  assumeUnconfirmed(spec, model);
  return { spec: behavior, model, findings: sorted };
}

const VALUE_ROLES: ReadonlySet<StorageRole> = new Set(["key", "from", "to"]);

/** What a value role needs, for messages. */
function roleNeeds(role: StorageRole): string {
  return role === "key" ? "a string or number" : "a state, or a list of states";
}

/** The properties of a parameter's type (each member of a union), if it is a plain object. */
function objectParts(ctx: ProjectContext, type: TS.Type): TS.Type[] {
  const parts = type.isUnionType() ? type.getTypes() : [type];
  // An array or tuple of states (`from`) has an index signature; a plain object has none.
  return parts.filter(
    (t) => (t.flags & ts.TypeFlags.Object) !== 0 && ctx.checker.getIndexInfosOfType(t).length === 0,
  );
}

/**
 * A role in a bound storage function's `args` that doesn't fit its parameter:
 * - a bare `key`, `from` or `to` on a parameter that is an object of named arguments
 *   (`getOrder({ tx, id, tenantId })` bound with `args: [key]`): the code check would take the
 *   whole object as the key, and the generated tests' fake too. The hint names the field form,
 *   `args: [{ id: key }]`;
 * - a field role (`args: [{ id: key }]`) on a parameter whose type has no such field.
 */
function roleArgumentIssue(
  ctx: ProjectContext,
  sym: TS.Symbol,
  fn: StorageFunction,
  keyField: string,
): { index: number; message: string; hint: string } | undefined {
  const decl = primaryDeclarationOf(sym);
  const params =
    decl && "parameters" in decl
      ? (decl as { parameters: readonly TS.ParameterDeclaration[] }).parameters
      : functionOfDeclaration(decl)?.parameters;
  if (!params) return undefined;
  const checker = ctx.checker;
  for (const [index, arg] of fn.args.entries()) {
    const param = params[index];
    if (!param || param.dotDotDotToken) continue;
    const type = checker.getTypeAtLocation(param);
    if (!type) continue;
    const text = ts.isObjectBindingPattern(param.name)
      ? oneLine(param.name)
      : param.type
        ? oneLine(param.type)
        : checker.typeToString(type);
    const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text;
    if (typeof arg === "string") {
      if (!VALUE_ROLES.has(arg)) continue;
      const objects = objectParts(ctx, type);
      if (objects.length === 0) continue;
      const wanted = arg === "key" ? keyField : arg;
      const has = objects.some((t) => checker.getPropertyOfType(t, wanted) !== undefined);
      const field = has ? wanted : "<field>";
      const args = fn.args.map((a, i) =>
        i === index ? `{ ${field}: ${arg} }` : formatStorageArg(a),
      );
      return {
        index,
        message: `is an object (${shown}), but its \`${arg}\` role needs ${roleNeeds(arg)}: tsverify can't tell which of its fields that is`,
        hint: `Name the field that carries the ${arg}: \`args: [${args.join(", ")}]\` (docs/behavior-format.md, storage roles).`,
      };
    }
    // Field roles: each named field must be a property of the parameter's type.
    const missing = (
      fields: StorageArg,
      t: TS.Type | undefined,
      path: string[],
    ): string[] | undefined => {
      // A type tsverify can't see into (`any`, a type parameter) is taken as having the field.
      if (typeof fields === "string" || !t || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
        return undefined;
      const present = checker.getNonNullableType(t);
      const apparent = present && checker.getApparentType(present);
      if (!apparent) return undefined;
      for (const [field, inner] of Object.entries(fields)) {
        const prop = checker.getPropertyOfType(apparent, field);
        if (!prop) return [...path, field];
        const found = missing(inner, checker.getTypeOfSymbol(prop), [...path, field]);
        if (found) return found;
      }
      return undefined;
    };
    const gap = missing(arg, type, []);
    if (gap) {
      return {
        index,
        message: `has no field \`${gap.join(".")}\` (its type is ${shown}), which \`args\` gives a role`,
        hint: `Name a field of the argument in \`args\` (\`{ ${keyField}: key }\` for \`${fn.ref.symbol}({ ${keyField}, … })\`), as the function's parameter type spells it.`,
      };
    }
  }
  return undefined;
}

/**
 * A bound client (`bindings.clients`) or storage function (`bindings.storage`, every kind) that
 * no call anywhere in the project resolves to is almost always a binding that points at the wrong
 * thing (an interface where the code calls a class, a value the code receives as `any`), and
 * then everything tsverify says about its calls ("never calls …") is wrong too. Each one gets an
 * `unanalyzable` warning, `unanalyzable:<behavior>:binding:<client | storage.<symbol>>`.
 * Returns the uncalled clients' names, with their finding ids, for the code model
 * (`BehaviorModel.uncalledClients`).
 */
function reportUncalled(
  spec: BehaviorModel,
  ctx: ProjectContext,
  calls: ClientCalls,
  clientSyms: ReadonlyMap<TS.Symbol, string>,
  storage: StorageFunctions | undefined,
  findings: Finding[],
): Record<string, string> {
  const files = ctx.analyzedFiles();
  const behavior = spec.name;
  const uncalled: Record<string, string> = {};
  const clients = new Set(clientSyms.values());
  const called = calls.calledClients(files, clients);
  for (const [name, binding] of sortedEntries(spec.bindings.clients)) {
    if (!clients.has(name) || called.has(name)) continue;
    const finding: Finding = {
      ...unanalyzable(
        behavior,
        "binding",
        name,
        `client "${name}" (${binding.module}#${binding.export}) is bound but never called: no call in the project resolves to it, so tsverify sees none of its calls`,
        {
          hint: `Check \`module\` and \`export\`: tsverify matches calls on the exported value itself, and on variables, parameters and fields typed as it (for a class or an interface, as its instances), so a client the code holds as another type (an interface when the class is bound, \`any\`) is never matched. Bind the type the code holds it as, or remove the binding.`,
        },
      ),
      ...(binding.at ? { specAt: binding.at } : {}),
    };
    findings.push(finding);
    uncalled[name] = finding.id;
  }
  const binding = spec.bindings.storage;
  if (storage && binding) {
    const calledFns = storage.called(files);
    for (const { kind, fn } of storageFunctions(binding)) {
      if (storage.path(fn.ref.symbol) === undefined || calledFns.has(fn.ref.symbol)) continue;
      const at = fn.at ?? binding.at;
      findings.push({
        ...unanalyzable(
          behavior,
          "binding",
          `${STORAGE_CLIENT}.${fn.ref.symbol}`,
          `storage ${kind} function ${formatSymbolRef(fn.ref)} is bound but never called: no call in the project resolves to it`,
          {
            hint: `Check the path and symbol: tsverify matches a call by the function it resolves to, so a method called through an interface (\`store: Store\`) resolves to the interface's method, not to a class that implements it. Bind the one the code calls, or remove the binding.`,
          },
        ),
        ...(at ? { specAt: at } : {}),
      });
    }
  }
  return uncalled;
}

/**
 * A spec transition whose impl reaches no readable write of its `to`, but a write tsverify
 * couldn't read that may be it (`unreadWrites`: its value is not a literal, or is `to`), is
 * unconfirmed: conformance says so (`unanalyzable`), and the code model takes it as specified,
 * like a transition without `impl`: copied unchanged and without `sites`. Leaving it out would
 * make the code model lose behavior the code may well have, and the checker report stuck states
 * and `eventually` violations that only come from what tsverify couldn't read.
 */
function assumeUnconfirmed(spec: BehaviorModel, model: BehaviorModel): void {
  let added = false;
  for (const t of spec.transitions) {
    const unread = model.unreadWrites?.[t.name] ?? [];
    if (!unread.some((u) => u.value === undefined || u.value === t.to)) continue;
    const written = model.transitions.some(
      (c) => c.sites?.specTransition === t.name && c.to === t.to,
    );
    if (written || model.transitions.some((c) => c.name === t.name)) continue;
    model.transitions.push(structuredClone(t));
    model.concurrency[t.name] = spec.concurrency[t.name] ?? 2;
    added = true;
  }
  if (!added) return;
  model.transitions.sort((a, b) => compareStrings(a.name, b.name));
  model.concurrency = Object.fromEntries(
    model.transitions.map((t) => [t.name, model.concurrency[t.name] as number]),
  );
}
