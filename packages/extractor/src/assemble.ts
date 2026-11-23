/**
 * Code-model assembly, following the conventions on `ModelOrigin` (`@tsverify/ir` model.ts):
 * - name: `t` when the write reached from `t`'s impl writes `t.to`, else `t->to`; an unlinked write
 *   is named after its function; collisions get `~2`, `~3`, … (linked first, then by location)
 * - `by`, `idempotent` from the linked spec transition (`[]` / `false` when unlinked)
 * - `requires` = bound guards that dominate the write; `atomic` = read and write share one scope
 *   (`memory`: no suspension point between the last re-check of the state field, else the impl's
 *   entry, and the write; scope `synchronous`). When the adapter can't decide it (the write is
 *   saved outside the named storage, or no read was found: an `unanalyzable` finding), a linked
 *   write keeps the spec transition's `atomic`, with the reason in `sites.atomicUnknown`
 * - effect multiplicity from the spec's declaration of that effect (`at-least-once` if undeclared);
 *   a linked write also has the spec transition's effects on a client no call resolves to
 *   (`uncalledClients`), as specified, since their calls can't be seen
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
import type { AtomicityNote, PersistenceAdapter, PersistenceFacts } from "./adapters/types";
import { frameNaming, frameOf, type Reach } from "./callgraph";
import type { FunctionLike } from "./cfg";
import type { ClientCall, ClientCalls } from "./client-calls";
import type { Dominance } from "./dominance";
import { effectCalls, effectNameOf, multiplicityOf } from "./effects";
import { unanalyzable } from "./findings";
import { guardArgOf } from "./guard-args";
import { traceToRoot } from "./invocation";
import { occurrenceOf } from "./occurrence";
import type { ProjectContext } from "./project";
import type * as TS from "./ts-types";
import type { Narrowed } from "./type-facts";
import { unreadCheckOf } from "./unread-check";
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
  /** Bound clients no call in the project resolves to (`BehaviorModel.uncalledClients`). */
  uncalledClients: ReadonlySet<string>;
}

/** The client an effect gate calls: `queue` for `queue.acknowledgeMessage`, `notify` for `notify`. */
export function clientOfGate(gate: string): string {
  const dot = gate.indexOf(".");
  return dot < 0 ? gate : gate.slice(0, dot);
}

function compareLoc(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

function baseName(d: Draft, functionName: string): string {
  if (!d.linked) return functionName;
  return d.linked.to === d.write.value ? d.linked.name : `${d.linked.name}->${d.write.value}`;
}

/** The hint of the `unanalyzable` from-state finding for a check tsverify can't read. */
const UNREAD_CHECK_HINT =
  'Check the state in a form tsverify reads, before the write: `if (x.status !== "a") throw`, a `switch`, `.includes` on a list of literals, or a helper declared as an assertion function (`function assertOpen(x): asserts x is Open`). See docs/authoring-guide.md §7.5, "Restructuring unanalyzable code".';

/** The hint of the `unanalyzable` from-state finding when the adapter gave none. */
const RESTRUCTURE_HINT =
  'Check the state with a comparison tsverify reads (`if (x.status !== "a") throw`, a `switch`, `.includes` on a list of literals) before the write (docs/authoring-guide.md §7.5).';

function fromStateOf(spec: BehaviorModel, m: MatchedWrite): FromState & { hint: string } {
  const n = m.narrowed;
  const ref = referenceText(m.write.ref) ?? m.write.ref.getText();
  const target = `${ref}.${m.write.field}`;
  if (n.values === "*") {
    if (!m.probed) {
      return {
        values: "*",
        unconstrained: false,
        reason: `${target} is not a plain reference (identifier, this or a property chain), so it cannot be probed`,
        hint: `Hold the ${spec.entity.name} in a local \`const\` or a parameter and write its ${m.write.field} through that name, so its state at the write can be read.`,
      };
    }
    if (n.declared === "*") {
      return {
        values: "*",
        unconstrained: false,
        reason: `${spec.entity.name}.${m.write.field} is typed ${n.declaredText}`,
        hint: `Type ${spec.entity.name}.${m.write.field} as a union of string literals so narrowing can be read.`,
      };
    }
    return {
      values: "*",
      unconstrained: false,
      reason: `the type of ${target} at the write is ${n.typeText}`,
      hint: RESTRUCTURE_HINT,
    };
  }
  if (n.unconstrained) {
    return {
      values: [...n.values],
      unconstrained: true,
      reason: `nothing narrows ${target} before the write: its type there is the full declared union ${n.declaredText}`,
      hint: RESTRUCTURE_HINT,
    };
  }
  return { values: [...n.values], unconstrained: false, hint: RESTRUCTURE_HINT };
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
  return guardArgOf(a, checker) !== undefined;
}

function invocationOf(
  env: AssembleEnv,
  d: Draft,
  p: PersistenceFacts,
  guardCalls: readonly TS.CallExpression[],
): InvocationShape | undefined {
  const checker = env.ctx.checker;
  const impl = implRefOf(env.ctx, d);
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
  const t = d.linked;
  const naming = frameNaming(m.frame);
  const linkAtomicity = env.adapter.linkAtomicity?.({
    write: m.write,
    frame: m.frame,
    reach: d.reach,
    checker: ctx.checker,
    facts: m.persistence,
  });
  const p: PersistenceFacts = linkAtomicity?.facts
    ? { ...m.persistence, ...linkAtomicity.facts }
    : m.persistence;
  let atomicScope: CodeSites["atomic"];
  if (linkAtomicity) {
    if (linkAtomicity.atomic && linkAtomicity.kind) {
      atomicScope = {
        kind: linkAtomicity.kind,
        at: linkAtomicity.at ? ctx.loc(linkAtomicity.at) : m.at,
        ...(linkAtomicity.gate ? { gate: linkAtomicity.gate } : {}),
      };
    }
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
  const seenMiss = new Set<string>();
  const guardMisses: NonNullable<CodeSites["guardMisses"]> = [];
  for (const s of guardFacts.misses) {
    const at = ctx.loc(s.call);
    const key = `${s.key}@${at.file}:${at.line}:${at.column}`;
    if (seenMiss.has(key)) continue;
    seenMiss.add(key);
    guardMisses.push({ guard: s.key, at, args: [...s.args] });
  }
  guardMisses.sort((a, b) => compareLoc(a.at, b.at) || compareStrings(a.guard, b.guard));
  const guardCalls = [...guardFacts.sites]
    .sort(
      (a, b) => Number(guardFacts.dominating.has(b.key)) - Number(guardFacts.dominating.has(a.key)),
    )
    .map((s) => s.call);

  // Effects that run only after a failed conditional save are not the transition's; ones that
  // can run although it failed escape the atomic step.
  let unchecked: ClientCall | undefined;
  const specEffects = new Set([
    ...Object.keys(spec.bindings.effects),
    ...spec.transitions.flatMap((x) => x.effects.map((e) => e.name)),
  ]);
  const attributed = effectCalls(
    d.reach,
    m.frame,
    m.write.expr,
    calls,
    env.persistenceClients,
  ).filter((cc) => {
    const outcome =
      env.adapter.effectOutcome?.({
        call: cc,
        write: m.write,
        frame: m.frame,
        reach: d.reach,
        checker: ctx.checker,
      }) ?? "attributed";
    // Only an effect the spec knows of escapes the atomic step: another call is reported as
    // `undeclared-effect`, "a gate no spec effect maps to", and can break no spec rule.
    if (outcome === "unchecked" && specEffects.has(effectNameOf(cc.gate, spec, t)))
      unchecked ??= cc;
    return outcome !== "excluded";
  });
  const effects: (CallSite & { effect: string })[] = attributed
    .map((cc) => ({ ...callSite(ctx, calls, cc, d.reach), effect: effectNameOf(cc.gate, spec, t) }))
    .sort((a, b) => compareLoc(a.at, b.at));
  // The linked transition's effects on a client no call resolves to can't be seen: they are
  // taken as specified, like the transition itself when its write can't be read.
  const assumed = (t?.effects ?? [])
    .map((e) => e.name)
    .filter((e) => env.uncalledClients.has(clientOfGate(spec.bindings.effects[e] ?? e)));
  const effectNames = [...new Set([...effects.map((e) => e.effect), ...assumed])].sort(
    compareStrings,
  );
  const effectDecls: EffectDecl[] = effectNames.map((e) => ({
    name: e,
    multiplicity: multiplicityOf(e, spec, t),
  }));

  const decided = p.fromState
    ? { ...p.fromState, hint: p.fromStateHint ?? RESTRUCTURE_HINT }
    : fromStateOf(spec, m);
  // Nothing narrows the state before the write, but the code consults it in a form tsverify
  // can't read (`unread-check.ts`): the from-state is unknown, not unchecked.
  const unread =
    !p.fromState && decided.unconstrained
      ? unreadCheckOf(
          m.write,
          m.frame,
          ctx.checker,
          (call) => calls.classify(call) !== undefined || dominance.keysOfCall(call).length > 0,
        )
      : undefined;
  const unreadAt = unread && ctx.loc(unread.at);
  const { hint: fromStateHint, ...fromState } =
    unread && unreadAt
      ? {
          values: "*" as const,
          unconstrained: false,
          reason: `the from-state check at ${unreadAt.file}:${unreadAt.line} is in a form tsverify can't read: \`${unread.text}\``,
          hint: UNREAD_CHECK_HINT,
        }
      : decided;
  const from =
    fromState.values === "*"
      ? "*"
      : spec.entity.states.filter((s) => (fromState.values as string[]).includes(s));
  // Every `*` from-state (a `string` field, an unprobeable reference, an adapter's `OR`) gets
  // exactly this one finding, `unanalyzable:<behavior>:from-state:<transition>`: it is the
  // report for that cause, so a consumer need not add a second one. (When several transitions'
  // impls reach one write, their copies become one finding naming them all: `mergeSharedWrites`.)
  if (fromState.values === "*") {
    env.findings.push(
      unanalyzable(
        spec.name,
        "from-state",
        name,
        unread
          ? `${name}: ${fromState.reason}, so the from-state of this write is unknown`
          : `${name}: the from-state of this write is unknown: ${fromState.reason}`,
        {
          transition: name,
          codeAt: m.at,
          hint: fromStateHint,
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
        hint:
          env.adapter.readHint ??
          "Read the entity through a bound client (`bindings.clients`) in the same function as the write.",
      }),
    );
  }
  // A write that bypasses the storage the spec names: tsverify cannot tell how it is stored.
  if (p.unbound) {
    env.findings.push(
      unanalyzable(spec.name, "storage", name, `${name}: ${p.unbound.message}`, {
        transition: name,
        codeAt: m.at,
        hint: p.unbound.hint,
      }),
    );
  }
  const escaped: AtomicityNote | undefined = unchecked && {
    subject: "unchecked-effect",
    message: `${unchecked.gate} can run although ${p.commit?.gate ?? "the conditional save"} found ${m.write.field} changed: the call is not behind a check of the save's result`,
    hint: `Check what ${p.commit?.gate ?? "the conditional save"} returns and stop when it saved nothing (\`if (!(await …)) throw …\`) before calling ${unchecked.gate}.`,
    at: unchecked.call,
  };
  let atomic = escaped ? false : (linkAtomicity?.atomic ?? p.atomic);
  if (escaped) atomicScope = undefined;
  // Atomicity tsverify could not decide (reported above as `unanalyzable`) gets no verdict: the
  // linked transition is taken as specified, like a spec transition without `impl`.
  const atomicUnknown =
    !atomic && !escaped && t !== undefined
      ? (p.unbound?.message ?? (t.atomic ? p.problems[0] : undefined))
      : undefined;
  if (atomicUnknown !== undefined && t) atomic = t.atomic;
  // Why a scoped-looking write is still not atomic: conformance reports it in `non-atomic`.
  const note = atomic ? undefined : (escaped ?? p.notes?.[0]);

  const invocation = invocationOf(env, d, p, guardCalls);
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
    ...(atomicUnknown !== undefined ? { atomicUnknown } : {}),
    guards,
    ...(guardFacts.sets ? { guardSets: guardFacts.sets } : {}),
    ...(guardMisses.length > 0 ? { guardMisses } : {}),
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
