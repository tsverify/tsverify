/**
 * Code-model assembly, following the conventions on `ModelOrigin` (`@tsverify/ir` model.ts):
 * - name: `t` when the write reached from `t`'s impl writes `t.to`, else `t->to`; an unlinked write
 *   is named after its function; collisions get `~2`, `~3`, … (linked first, then by location)
 * - `by`, `idempotent` from the linked spec transition (`[]` / `false` when unlinked)
 * - `requires` = bound guards that dominate the write; `atomic` = read and write share one scope
 *   (`memory`: no suspension point between the last re-check of the state field, else the impl's
 *   entry, and the write; scope `synchronous`)
 * - effect multiplicity from the spec's declaration of that effect (`at-least-once` if undeclared)
 * - `concurrency` copies the linked spec transition's bound (2 when unlinked)
 * - name, entity, actors, rules, bindings and file are copied from the spec; transitions sorted
 *   by name; `at` = the write.
 * - `implAt`: for each spec transition whose `impl` resolves, where the impl function is declared
 *   (its name, like `CodeSites.function.at`), keyed by transition name.
 *
 * `from`: the narrowed literal set, restricted to `entity.states` (in that order); `"*"` when the
 * type is not a finite literal set. The full declared union stays a list, with
 * `sites.fromState.unconstrained: true`.
 */
import type {
  ArgPath,
  BehaviorModel,
  CallSite,
  CodeSites,
  EffectDecl,
  Finding,
  FromState,
  GuardRef,
  InvocationShape,
  PersistenceKind,
  SourceLocation,
  SymbolRef,
  Transition,
} from "@tsverify/ir";
import { compareStrings, parseGuardRef } from "@tsverify/ir";
import type { PersistenceAdapter, PersistenceFacts } from "./adapters/types";
import { frameNaming, frameOf, type Reach } from "./callgraph";
import type { FunctionLike } from "./cfg";
import type { ClientCall, ClientCalls } from "./client-calls";
import type { Dominance } from "./dominance";
import { effectCalls, effectNameOf, multiplicityOf } from "./effects";
import { unanalyzable } from "./findings";
import { traceToRoot } from "./invocation";
import { occurrenceOf } from "./occurrence";
import type { ProjectContext } from "./project";
import type * as TS from "./ts-types";
import { type Narrowed, singleLiteralOf } from "./type-facts";
import { referenceText, type WriteNode } from "./writes";

export interface MatchedWrite {
  write: WriteNode;
  at: SourceLocation;
  /** The written state. */
  value: string;
  narrowed: Narrowed;
  probed: boolean;
  frame: FunctionLike;
  persistence: PersistenceFacts;
}

export interface Draft {
  write: MatchedWrite;
  /** The impl's reach (linked), or the write's own frame's reach (unlinked). */
  reach: Reach;
  linked?: Transition;
}

export interface AssembleEnv {
  ctx: ProjectContext;
  calls: ClientCalls;
  dominance: Dominance;
  persistenceClients: ReadonlySet<string>;
  persistence: PersistenceKind;
  adapter: PersistenceAdapter;
  /** Collects findings (appended to). */
  findings: Finding[];
  /** Declaration location of each resolved spec `impl`, by transition name (sorted). */
  implAt: Record<string, SourceLocation>;
}

function compareLoc(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

function baseName(d: Draft, functionName: string): string {
  if (!d.linked) return functionName;
  return d.linked.to === d.write.value ? d.linked.name : `${d.linked.name}->${d.write.value}`;
}

function fromStateOf(spec: BehaviorModel, m: MatchedWrite): FromState {
  const n = m.narrowed;
  const ref = referenceText(m.write.ref) ?? m.write.ref.getText();
  const target = `${ref}.${m.write.field}`;
  if (n.values === "*") {
    let reason: string;
    if (!m.probed)
      reason = `${target} is not a plain reference (identifier, this or a property chain), so it cannot be probed`;
    else if (n.declared === "*")
      reason = `${spec.entity.name}.${m.write.field} is typed ${n.declaredText}`;
    else reason = `the type of ${target} at the write is ${n.typeText}`;
    return { values: "*", unconstrained: false, reason };
  }
  if (n.unconstrained) {
    return {
      values: [...n.values],
      unconstrained: true,
      reason: `nothing narrows ${target} before the write: its type there is the full declared union ${n.declaredText}`,
    };
  }
  return { values: [...n.values], unconstrained: false };
}

function callSite(
  ctx: ProjectContext,
  calls: ClientCalls,
  cc: ClientCall,
  reachOf: Reach,
): CallSite {
  const frame = frameOf(cc.call);
  return {
    at: ctx.loc(cc.call),
    client: cc.client,
    path: cc.path,
    gate: cc.gate,
    occurrence: frame ? occurrenceOf(cc.call, frame, cc.gate, reachOf, calls) : 0,
  };
}

function implRefOf(ctx: ProjectContext, d: Draft): SymbolRef | undefined {
  if (d.linked) return d.linked.impl;
  const { name } = frameNaming(d.reach.root);
  if (name === "anonymous" || name === "default") return undefined;
  return { file: ctx.rel(d.reach.root.getSourceFile().fileName), symbol: name };
}

function isLiteralArg(a: TS.Expression, checker: TS.Checker): boolean {
  return singleLiteralOf(checker.getTypeAtLocation(a), checker) !== undefined;
}

function invocationOf(
  env: AssembleEnv,
  d: Draft,
  guardCalls: readonly TS.CallExpression[],
): InvocationShape | undefined {
  const checker = env.ctx.checker;
  const impl = implRefOf(env.ctx, d);
  const p = d.write.persistence;
  const idArg = p.entityKey ?? p.read?.call.arguments[0];
  if (!impl || !idArg) return undefined;
  const entityId = traceToRoot(idArg, d.reach, checker);
  if (!entityId) return undefined;
  let actor: ArgPath | undefined;
  for (const call of guardCalls) {
    for (const a of call.arguments) {
      if (isLiteralArg(a, checker)) continue;
      actor = traceToRoot(a, d.reach, checker);
      if (actor) break;
    }
    if (actor) break;
  }
  return { impl, entityId, ...(actor ? { actor } : {}) };
}

function buildTransition(
  spec: BehaviorModel,
  d: Draft,
  name: string,
  env: AssembleEnv,
): Transition {
  const { ctx, calls, dominance } = env;
  const m = d.write;
  const p = m.persistence;
  const t = d.linked;
  const naming = frameNaming(m.frame);
  const linkAtomicity = env.adapter.linkAtomicity?.({
    write: m.write,
    frame: m.frame,
    reach: d.reach,
    checker: ctx.checker,
  });
  let atomicScope: CodeSites["atomic"];
  if (linkAtomicity) {
    if (linkAtomicity.atomic && linkAtomicity.kind)
      atomicScope = { kind: linkAtomicity.kind, at: m.at };
  } else if (p.atomicAt) {
    atomicScope = { kind: p.atomicAt.kind, at: ctx.loc(p.atomicAt.call), gate: p.atomicAt.gate };
  } else if (p.scope) {
    atomicScope = { kind: p.scope.kind, at: ctx.loc(p.scope.call), gate: p.scope.gate };
  }

  const guardFacts = dominance.analyze(d.reach, m.frame, m.write.expr);
  const requires: GuardRef[] = [...guardFacts.dominating]
    .sort(compareStrings)
    .map((k) => parseGuardRef(k) ?? { name: k, args: [], raw: k });
  const seenGuard = new Set<string>();
  const guards: CodeSites["guards"] = [];
  for (const s of guardFacts.sites) {
    const at = ctx.loc(s.call);
    const key = `${s.key}@${at.file}:${at.line}:${at.column}`;
    if (seenGuard.has(key)) continue;
    seenGuard.add(key);
    guards.push({ guard: s.key, at, dominates: guardFacts.dominating.has(s.key) });
  }
  guards.sort((a, b) => compareLoc(a.at, b.at) || compareStrings(a.guard, b.guard));
  const guardCalls = [...guardFacts.sites]
    .sort(
      (a, b) => Number(guardFacts.dominating.has(b.key)) - Number(guardFacts.dominating.has(a.key)),
    )
    .map((s) => s.call);

  const effects: (CallSite & { effect: string })[] = effectCalls(
    d.reach,
    m.frame,
    m.write.expr,
    calls,
    env.persistenceClients,
  )
    .map((cc) => ({ ...callSite(ctx, calls, cc, d.reach), effect: effectNameOf(cc.gate, spec, t) }))
    .sort((a, b) => compareLoc(a.at, b.at));
  const effectNames = [...new Set(effects.map((e) => e.effect))].sort(compareStrings);
  const effectDecls: EffectDecl[] = effectNames.map((e) => ({
    name: e,
    multiplicity: multiplicityOf(e, spec, t),
  }));

  const fromState = p.fromState ?? fromStateOf(spec, m);
  const from =
    fromState.values === "*"
      ? "*"
      : spec.entity.states.filter((s) => (fromState.values as string[]).includes(s));
  // Every `*` from-state (a `string` field, an unprobeable reference, an adapter's `OR`) gets
  // exactly this one finding, `unanalyzable:<behavior>:from-state:<transition>`: it is the
  // report for that cause, so a consumer need not add a second one.
  if (fromState.values === "*") {
    env.findings.push(
      unanalyzable(
        spec.name,
        "from-state",
        name,
        `${name}: the from-state of this write is unknown: ${fromState.reason}`,
        {
          transition: name,
          codeAt: m.at,
          hint: `Type ${spec.entity.name}.${m.write.field} as a union of string literals so narrowing can be read.`,
        },
      ),
    );
  }
  // Persistence problems only make atomicity undecidable: noise unless the spec asks for atomic.
  for (const problem of t?.atomic ? p.problems : []) {
    env.findings.push(
      unanalyzable(spec.name, "read", name, `${name}: ${problem}`, {
        transition: name,
        codeAt: m.at,
        hint: "Read the entity through a bound client (`bindings.clients`) in the same function as the write.",
      }),
    );
  }
  const atomic = linkAtomicity?.atomic ?? p.atomic;
  // Why a scoped-looking write is still not atomic: conformance reports it in `non-atomic`.
  const note = atomic ? undefined : p.notes?.[0];

  const invocation = invocationOf(env, d, guardCalls);
  const sites: CodeSites = {
    persistence: env.persistence,
    write: m.at,
    function: {
      file: ctx.rel(m.frame.getSourceFile().fileName),
      name: naming.name,
      at: ctx.loc(naming.node),
    },
    ...(t ? { specTransition: t.name } : {}),
    fromState,
    ...(p.read ? { read: callSite(ctx, calls, p.read, d.reach) } : {}),
    ...(p.commit ? { commit: callSite(ctx, calls, p.commit, d.reach) } : {}),
    ...(atomicScope ? { atomic: atomicScope } : {}),
    ...(note
      ? { atomicNote: { message: note.message, hint: note.hint, at: ctx.loc(note.at) } }
      : {}),
    guards,
    ...(guardFacts.sets ? { guardSets: guardFacts.sets } : {}),
    effects,
    ...(invocation ? { invocation } : {}),
    ...(p.storage ? { storage: p.storage } : {}),
  };
  const impl = implRefOf(ctx, d);
  return {
    name,
    from,
    to: m.value,
    by: t ? [...t.by] : [],
    requires,
    effects: effectDecls,
    atomic,
    idempotent: t?.idempotent ?? false,
    ...(impl ? { impl: { ...impl } } : {}),
    at: m.at,
    sites,
  };
}

export function assemble(spec: BehaviorModel, drafts: Draft[], env: AssembleEnv): BehaviorModel {
  // Names: group by base name; linked before unlinked, then by write location.
  const based = drafts.map((d) => ({ d, base: baseName(d, frameNaming(d.write.frame).name) }));
  based.sort(
    (a, b) =>
      compareStrings(a.base, b.base) ||
      Number(a.d.linked === undefined) - Number(b.d.linked === undefined) ||
      compareLoc(a.d.write.at, b.d.write.at) ||
      compareStrings(a.d.linked?.name ?? "", b.d.linked?.name ?? ""),
  );
  const count = new Map<string, number>();
  const transitions: Transition[] = [];
  const concurrency: Record<string, number> = {};
  for (const { d, base } of based) {
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    const name = n === 1 ? base : `${base}~${n}`;
    transitions.push(buildTransition(spec, d, name, env));
    concurrency[name] = d.linked ? (spec.concurrency[d.linked.name] ?? 2) : 2;
  }
  // Spec transitions without `impl` can't be checked against code, so they are assumed to behave
  // as specified: copied unchanged and without `sites`. Leaving them out would make the code model
  // lose behavior and the checker report false implementation-property violations.
  for (const t of spec.transitions) {
    if (t.impl !== undefined || transitions.some((c) => c.name === t.name)) continue;
    transitions.push(structuredClone(t));
    concurrency[t.name] = spec.concurrency[t.name] ?? 2;
  }
  transitions.sort((a, b) => compareStrings(a.name, b.name));
  const sortedConcurrency: Record<string, number> = {};
  for (const t of transitions) sortedConcurrency[t.name] = concurrency[t.name] as number;

  const copy = structuredClone({
    entity: spec.entity,
    actors: spec.actors,
    rules: spec.rules,
    bindings: spec.bindings,
  });
  // The code may write or check states the spec doesn't declare (`light.status = "broken"`).
  // The as-implemented entity has them, so the code model stays checkable; conformance reports
  // each such write as `undeclared-transition`.
  const declared = new Set(copy.entity.states);
  const extra = new Set<string>();
  for (const t of transitions) {
    for (const s of [t.to, ...(t.from === "*" ? [] : t.from)]) if (!declared.has(s)) extra.add(s);
  }
  copy.entity.states.push(...[...extra].sort(compareStrings));

  return {
    kind: "entity",
    name: spec.name,
    origin: "code",
    ...(spec.file !== undefined ? { file: spec.file } : {}),
    entity: copy.entity,
    actors: copy.actors,
    transitions,
    rules: copy.rules,
    concurrency: sortedConcurrency,
    bindings: copy.bindings,
    implAt: structuredClone(env.implAt),
  };
}
