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
 */
import type {
  BehaviorModel,
  Finding,
  PersistenceKind,
  SourceLocation,
  UnreadWrite,
} from "@tsverify/ir";
import { compareStrings, formatSymbolRef, storageFunctions } from "@tsverify/ir";
import { assignAdapter } from "./adapters/assign";
import {
  type BoundFunction,
  functionsAdapter,
  STORAGE_CLIENT,
  StorageFunctions,
} from "./adapters/functions";
import { memoryAdapter } from "./adapters/memory";
import { prismaAdapter } from "./adapters/prisma";
import type { PersistenceAdapter, PersistenceFacts } from "./adapters/types";
import { assemble, type Draft, type MatchedWrite } from "./assemble";
import { Callees, frameCalls, frameNaming, frameOf, type Reach, reach } from "./callgraph";
import type { FunctionLike } from "./cfg";
import { ClientCalls } from "./client-calls";
import { Dominance } from "./dominance";
import { matchesEntity, writtenValue } from "./entity";
import { brokenLink, sortFindings, unanalyzable, uniqueIds } from "./findings";
import { loadTypeScript, TypeScriptSetupError } from "./load-typescript";
import { type LoadedProject, loadProject, ProjectContext } from "./project";
import {
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
  singleLiteralOf,
  typeNames,
  withMembershipGuards,
} from "./type-facts";
import { type TypeScript, ts, useTypeScript } from "./typescript";
import { findCandidateWrites, type PatchOptions, rebindWrites, type WriteNode } from "./writes";

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

function literalArgs(call: TS.CallExpression, checker: TS.Checker): string[] {
  const out: string[] = [];
  for (const a of call.arguments) {
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isNumericLiteral(a)) {
      out.push(a.text);
    } else if (a.kind === ts.SyntaxKind.TrueKeyword) out.push("true");
    else if (a.kind === ts.SyntaxKind.FalseKeyword) out.push("false");
    else {
      const v = singleLiteralOf(checker.getTypeAtLocation(a), checker);
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

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

/** `patch` write discovery, only when some spec names its own storage functions. */
function patchOptions(specs: readonly BehaviorModel[]): PatchOptions | undefined {
  const named = specs.filter((s) => s.bindings.storage !== undefined);
  if (named.length === 0) return undefined;
  return {
    fields: new Set(named.map((s) => s.entity.stateField)),
    readSymbols: named.flatMap((s) => s.bindings.storage?.read.map((f) => f.ref.symbol) ?? []),
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
export function extractAll(
  specs: BehaviorModel[],
  options: ExtractOptions,
): { results: ExtractResult[]; stats: ExtractStats } {
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
): { results: ExtractResult[]; stats: ExtractStats } {
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
  const env: Env = { ctx, writes, types, callees: new Callees(ctx) };
  const results = specs.map((spec) => extractSpec(spec, env));
  return {
    results,
    stats: {
      files: loaded.files.length,
      writes: candidates.length,
      probes: requests.length,
      durationMs: now() - start,
    },
  };
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
  if (storageBinding) {
    const bound = new Map<TS.Symbol, BoundFunction>();
    for (const { kind: fnKind, fn } of storageFunctions(storageBinding)) {
      const r = resolveStorageFunction(ctx, fn);
      if (r.ok) bound.set(r.value, { kind: fnKind, fn, path: fn.ref.symbol });
      else {
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
          hint: "Only the `assign`, `memory` and `prisma` adapters exist in this version; set `bindings.persistence: assign` if the code assigns and saves whole objects, `prisma` for a Prisma client, or `memory` for in-process objects.",
        },
      ),
    );
    return { spec: behavior, findings };
  }

  // Links: clients, guards, impls.
  const clientSyms = new Map<TS.Symbol, string>();
  for (const [name, binding] of sortedEntries(spec.bindings.clients)) {
    const r = resolveClient(ctx, binding);
    if (r.ok) clientSyms.set(r.value, name);
    else {
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
  const calls = new ClientCalls(
    checker,
    clientSyms,
    adapter,
    storage && ((call) => storage.clientCall(call)),
  );
  const guardSyms = new Set(guards.map((g) => g.sym));
  const calleeSym = (call: TS.CallExpression) => symbolOf(call.expression, checker);
  const match = (call: TS.CallExpression): string[] => {
    const sym = calleeSym(call);
    if (!sym || !guardSyms.has(sym)) return [];
    const lits = literalArgs(call, checker);
    return guards
      .filter(
        (g) =>
          g.sym === sym && g.args.length === lits.length && g.args.every((a, i) => a === lits[i]),
      )
      .map((g) => g.key);
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
  const implAt: Record<string, SourceLocation> = {};
  for (const t of [...spec.transitions].sort((a, b) => compareStrings(a.name, b.name))) {
    if (!t.impl) continue;
    const r = resolveImpl(ctx, t.impl);
    if (r.ok) {
      impls.push({ name: t.name, fn: r.value, reach: reachFrom(r.value) });
      implAt[t.name] = ctx.loc(frameNaming(r.value).node);
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
  [...env.writes, ...extra].forEach((write, i) => {
    if (write.field !== spec.entity.stateField || !adapter.writeKinds.has(write.kind)) return;
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
    // The exact-union fallback needs a recognized read: DTOs and events share the union.
    if (match === "union" && (!frame || !analyze(frame).read)) return;
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

  const model = assemble(spec, drafts, {
    ctx,
    calls,
    dominance,
    persistenceClients,
    persistence: kind,
    adapter,
    findings,
    implAt,
  });
  const sorted = sortFindings(uniqueIds(findings));
  // After `uniqueIds`: each unread write names its finding by its final id.
  const unreadWrites: Record<string, UnreadWrite[]> = {};
  for (const impl of impls) {
    const reached = unread
      .filter((u) => impl.reach.frames.includes(u.frame))
      .map((u) => ({ ...u.write, finding: u.finding.id }));
    if (reached.length > 0) unreadWrites[impl.name] = reached;
  }
  if (Object.keys(unreadWrites).length > 0) model.unreadWrites = unreadWrites;
  return { spec: behavior, model, findings: sorted };
}
