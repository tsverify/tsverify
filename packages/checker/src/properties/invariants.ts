import {
  type Finding,
  type Rule,
  ruleProperty,
  type SourceLocation,
  type Trace,
  transitionLabel,
} from "@tsverify/ir";
import { type EffectCode, encodedAccess } from "../encode";
import { type CompiledExpr, compileExpr } from "../eval";
import { type CheckContext, type PropertyChecker, propertyFinding } from "./context";

interface RuleWatch {
  rule: Rule;
  /** true in a state that violates the rule. */
  violated: CompiledExpr<Uint16Array>;
  /** First (shallowest) violating state, or -1. */
  first: number;
}

interface EffectWatch {
  effect: EffectCode;
  first: number;
}

function code(name: string): string {
  return `\`${name}\``;
}

/**
 * How to remove a check-then-act gap. For a spec model the fix is in the spec (`atomic: true`);
 * for a code model the spec already says what it wants and the fix is in the code.
 */
function atomicHint(ctx: CheckContext, names: readonly string[]): string {
  // A code model's `t~2` is named by its spec transition and where the write is.
  const list = [...new Set(names.map((n) => code(transitionLabel(ctx.model, n))))];
  if (ctx.model.origin === "code") {
    return list.length === 1
      ? `make ${list[0]}'s state check and write atomic in the code (one transaction or a conditional update)`
      : `make the state checks and writes of ${list.join(", ")} atomic in the code (one transaction or a conditional update)`;
  }
  return list.length === 1
    ? `mark ${list[0]} atomic: true, or make its state write conditional`
    : `mark ${list.join(", ")} atomic: true, or make their state writes conditional`;
}

/**
 * Transitions with a stale write in the trace: a `write` whose worker observed a status other than
 * the current one, i.e. the check-then-act gap was actually exploited.
 */
export function staleWriters(trace: Trace): string[] {
  const out = new Set<string>();
  for (let i = 1; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    const before = trace.steps[i - 1];
    if (!step?.action || !before || step.action.kind !== "write") continue;
    const worker = step.state.workers.find((w) => w.id === step.action?.worker);
    if (worker?.observed !== before.state.status) out.add(step.action.transition);
  }
  return [...out].sort();
}

/** The transitions that take a step in `trace`. */
function actingIn(trace: Trace): Set<string> {
  const out = new Set<string>();
  for (const step of trace.steps) if (step.action) out.add(step.action.transition);
  return out;
}

/**
 * The transitions that fire `effect`, those taking a step in `trace` first: the hint and the
 * location are about the counterexample, not about another emitter that is not in it.
 */
function emittersOf(ctx: CheckContext, effect: EffectCode, trace: Trace) {
  const all = ctx.model.transitions.filter((t) => effect.emitters.includes(t.name));
  const acting = actingIn(trace);
  const inTrace = all.filter((t) => acting.has(t.name));
  return inTrace.length > 0 ? inTrace : all;
}

function effectHint(ctx: CheckContext, effect: EffectCode, trace: Trace): string {
  const emitters = emittersOf(ctx, effect, trace);
  const nonAtomic = emitters.filter((t) => !t.atomic).map((t) => t.name);
  if (nonAtomic.length > 0) return atomicHint(ctx, nonAtomic);
  // The emitters are atomic, so something else re-enabled them: a stale write, if there is one.
  const stale = staleWriters(trace);
  if (stale.length > 0) return atomicHint(ctx, stale);
  const names = [...new Set(emitters.map((t) => code(transitionLabel(ctx.model, t.name))))].join(
    ", ",
  );
  return `narrow the \`from\` states of ${names} so a repeated invocation is rejected, or deduplicate ${code(effect.name)}`;
}

/**
 * The spec location of an effect: its declaration on the first emitter, else that transition.
 * In a code model a transition's `at` is the write in the code, so only a declaration counts.
 */
function effectAt(ctx: CheckContext, effect: EffectCode): SourceLocation | undefined {
  const t = ctx.model.transitions.find((t) => t.name === effect.emitters[0]);
  const declared = t?.effects.find((e) => e.name === effect.name)?.at;
  return ctx.model.origin === "code" ? declared : (declared ?? t?.at);
}

/**
 * In a code model: the effect's call site, else the write, of the first emitter that takes a step
 * in `trace` (of the first emitter when none does).
 */
function effectCodeAt(
  ctx: CheckContext,
  effect: EffectCode,
  trace: Trace,
): SourceLocation | undefined {
  const emitters = emittersOf(ctx, effect, trace);
  for (const t of emitters) {
    const site = t.sites?.effects?.find((e) => e.effect === effect.name);
    if (site) return site.at;
  }
  return emitters[0]?.at;
}

/** `always` / `never` rules and the `effect-multiplicity` built-in, checked on every state. */
export function invariants(ctx: CheckContext): PropertyChecker {
  const access = encodedAccess(ctx.layout);
  const rules: RuleWatch[] = [];
  for (const rule of ctx.model.rules) {
    if (rule.kind === "eventually") continue;
    const holds = compileExpr(rule.expr, access);
    // never: the expression holds in no state; always: it holds in every state.
    const violated: CompiledExpr<Uint16Array> =
      rule.kind === "never" ? holds : (s: Uint16Array) => !holds(s);
    rules.push({ rule, violated, first: -1 });
  }
  const effects: EffectWatch[] = ctx.layout.effects
    .filter((e) => e.multiplicity === "exactly-once")
    .map((effect) => ({ effect, first: -1 }));
  let pendingRules = rules;
  let pendingEffects = effects;

  return {
    onState(id, s) {
      if (pendingRules.length > 0) {
        let found = false;
        for (const w of pendingRules) {
          if (w.violated(s)) {
            w.first = id;
            found = true;
          }
        }
        if (found) pendingRules = pendingRules.filter((w) => w.first === -1);
      }
      if (pendingEffects.length > 0) {
        let found = false;
        for (const w of pendingEffects) {
          if ((s[w.effect.field] as number) > 1) {
            w.first = id;
            found = true;
          }
        }
        if (found) pendingEffects = pendingEffects.filter((w) => w.first === -1);
      }
    },

    findings({ trace }) {
      const out: Finding[] = [];
      for (const { rule, first } of rules) {
        if (first === -1) continue;
        const property = ruleProperty(rule.name);
        const t = trace(first, property, "invariant");
        const stale = staleWriters(t);
        const what =
          rule.kind === "never" ? "a reachable state satisfies it" : "a reachable state breaks it";
        out.push(
          propertyFinding(ctx, property, undefined, {
            severity: "error",
            message: `Rule "${rule.name}" (${rule.kind}: ${rule.source}) is violated: ${what}.`,
            ...(rule.at && { specAt: rule.at }),
            trace: t,
            ...(stale.length > 0 && { hint: atomicHint(ctx, stale) }),
          }),
        );
      }
      for (const { effect, first } of effects) {
        if (first === -1) continue;
        const property = "effect-multiplicity";
        const at = effectAt(ctx, effect);
        const t = trace(first, property, "invariant");
        const codeAt = ctx.model.origin === "code" ? effectCodeAt(ctx, effect, t) : undefined;
        const fired = t.steps[t.steps.length - 1]?.state.effects[effect.name] ?? 2;
        out.push(
          propertyFinding(ctx, property, effect.name, {
            severity: "error",
            message: `Exactly-once effect ${code(effect.name)} fires ${fired} times for one ${ctx.model.entity.name}.`,
            ...(effect.emitters.length === 1 && { transition: effect.emitters[0] }),
            ...(at && { specAt: at }),
            ...(codeAt && { codeAt }),
            trace: t,
            hint: effectHint(ctx, effect, t),
          }),
        );
      }
      return out;
    },
  };
}
