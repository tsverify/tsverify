import {
  type BehaviorModel,
  compareStrings,
  type Finding,
  type GuardRef,
  type SourceLocation,
  type Transition,
} from "@tsverify/ir";
import { earliest, type Pairing, pairingFinding } from "./finding";

interface RequiredGuard {
  guard: GuardRef;
  /** Where the requirement comes from, e.g. `refund.requires` or `actor admin`. */
  sources: string[];
}

/** `t.requires` ∪ the `requires` of every actor in `t.by`, keyed by `GuardRef.raw`, sorted. */
export function requiredGuards(spec: BehaviorModel, t: Transition): RequiredGuard[] {
  const byRaw = new Map<string, RequiredGuard>();
  const add = (guard: GuardRef, source: string) => {
    const entry = byRaw.get(guard.raw) ?? { guard, sources: [] };
    entry.sources.push(source);
    byRaw.set(guard.raw, entry);
  };
  for (const g of t.requires) add(g, `${t.name}.requires`);
  for (const name of t.by)
    for (const g of spec.actors[name]?.requires ?? []) add(g, `actor ${name}`);
  return [...byRaw.values()].sort((a, b) => compareStrings(a.guard.raw, b.guard.raw));
}

/** One way to be allowed to perform `t`: acting as `actor`, passing `guards` (beyond `t.requires`). */
interface Alternative {
  actor: string;
  /** The actor's `requires` minus the transition's own, deduplicated, in spec order. */
  guards: GuardRef[];
}

/**
 * How the actors in `t.by` constrain the guards beyond `t.requires`:
 * - `none`: some listed actor needs nothing more, so passing `t.requires` is enough
 * - `same`: every listed actor needs the same guards (one actor, or identical `requires`); they
 *   are required like `t.requires`, one by one
 * - `any`: the actors are alternatives with different guards; a call must pass all of one's
 */
type ActorGuards =
  | { kind: "none" }
  | { kind: "same" }
  | { kind: "any"; alternatives: Alternative[] };

function actorGuards(spec: BehaviorModel, t: Transition): ActorGuards {
  const own = new Set(t.requires.map((g) => g.raw));
  const list: Alternative[] = [];
  for (const actor of new Set(t.by)) {
    // An actor missing from `actors` is an invalid spec, reported by @tsverify/spec; skip it here.
    const declared = spec.actors[actor];
    if (declared === undefined) continue;
    const seen = new Set<string>();
    const guards = declared.requires.filter((g) => {
      if (own.has(g.raw) || seen.has(g.raw)) return false;
      seen.add(g.raw);
      return true;
    });
    list.push({ actor, guards });
  }
  if (list.length === 0 || list.some((a) => a.guards.length === 0)) return { kind: "none" };
  const keys = new Set(list.map((a) => setKey(a.guards.map((g) => g.raw))));
  return keys.size === 1 ? { kind: "same" } : { kind: "any", alternatives: list };
}

function setKey(raws: string[]): string {
  return [...raws].sort(compareStrings).join("\u0000");
}

/**
 * Guard rules. `by: [a, b]` means any listed actor: a call is authorized when it passes the
 * transition's own `requires` and all the `requires` of at least one listed actor.
 *
 * - Each guard in `t.requires` must dominate the write (`code.requires`, see `ModelOrigin`): one
 *   finding per guard. `codeAt` is the earliest call of that guard that does not dominate, or the
 *   write when it is never called; `specAt` is the `requires` item.
 * - When some listed actor needs nothing beyond `t.requires`, that is all. When every listed
 *   actor needs the same guards (one actor in `by`, or identical `requires`), those are checked
 *   the same way, one by one (`specAt`: the transition's item when it lists the guard, else the
 *   first actor's in `t.by`).
 * - With alternative actors, every set of guards some path passes (`sites.guardSets`) must hold
 *   all of one listed actor's guards: one finding per failing set. Without `guardSets`, the
 *   guards that dominate stand in for the one set every path passes. `specAt` is the first
 *   missing `requires` item of the closest actor (fewest missing guards), else the transition;
 *   `codeAt` is the earliest non-dominating call of one of those guards, else the write.
 */
export function checkGuards(p: Pairing): Finding[] {
  const { spec, t } = p;
  const actors = actorGuards(spec, t);
  const required = requiredGuards(spec, t);
  if (actors.kind === "same") return perGuard(p, required);
  const own = new Set(t.requires.map((g) => g.raw));
  const transitionGuards = perGuard(
    p,
    required.filter((r) => own.has(r.guard.raw)),
  );
  return actors.kind === "none"
    ? transitionGuards
    : [...transitionGuards, ...byAlternatives(p, actors.alternatives)];
}

function entryOf(t: Transition): string {
  return t.impl === undefined ? "the impl" : t.impl.symbol;
}

function callOf(spec: BehaviorModel, raw: string): string {
  return spec.bindings.guards[raw]?.symbol ?? `the ${raw} guard`;
}

/** The earliest call of `raw`'s function with other arguments than its binding's, if any. */
function firstMiss(
  sites: Pairing["sites"],
  raw: string,
): { at: SourceLocation; args: string[] } | undefined {
  const misses = (sites.guardMisses ?? []).filter((m) => m.guard === raw);
  const at = earliest(misses.map((m) => m.at));
  return misses.find((m) => m.at === at);
}

/** Guard arguments as written in messages: `"admin"`, `["owner", "admin"]`, `2`. */
function argList(args: readonly string[]): string {
  if (args.length === 0) return "no literal arguments";
  return args.map((a) => (/^[[\d]|^(true|false)$/.test(a) ? a : JSON.stringify(a))).join(", ");
}

/** One finding per required guard that does not dominate the write. */
function perGuard(p: Pairing, required: RequiredGuard[]): Finding[] {
  const { spec, t, code, sites } = p;
  const dominating = new Set(code.requires.map((g) => g.raw));
  const findings: Finding[] = [];
  for (const { guard, sources } of required) {
    if (dominating.has(guard.raw)) continue;
    const partial = earliest(
      sites.guards.filter((g) => g.guard === guard.raw && !g.dominates).map((g) => g.at),
    );
    const call = callOf(spec, guard.raw);
    const miss = partial === undefined ? firstMiss(sites, guard.raw) : undefined;
    if (miss) {
      const wanted = spec.bindings.guards[guard.raw]?.args ?? [];
      findings.push(
        pairingFinding(p, {
          category: "guard-not-dominating",
          severity: "error",
          subject: guard.raw,
          message:
            `${t.name}: ${guard.raw} (${call}) is called before the write, but not with ` +
            `${argList(wanted)}: the call passes ${argList(miss.args)} ` +
            `(required by ${sources.join(", ")}).`,
          hint: `Pass ${argList(wanted)} as literal arguments (a list may also be a \`const\` holding an array literal), or bind ${guard.raw} to the arguments the code passes.`,
          ...(guard.at === undefined ? {} : { specAt: guard.at }),
          codeAt: miss.at,
        }),
      );
      continue;
    }
    const how = partial === undefined ? "is never called" : "is called on some paths but not all";
    findings.push(
      pairingFinding(p, {
        category: "guard-not-dominating",
        severity: "error",
        subject: guard.raw,
        message:
          `${t.name}: ${guard.raw} (${call}) ${how} before the write ` +
          `(required by ${sources.join(", ")}).`,
        hint: `Call ${call} on every path from ${entryOf(t)} to the write, before any early return.`,
        ...(guard.at === undefined ? {} : { specAt: guard.at }),
        codeAt: partial ?? sites.write,
      }),
    );
  }
  return findings;
}

/**
 * Alternative actors: one finding per guard set (a path's, or the dominating guards when the
 * extractor gave no `guardSets`) that holds none of the listed actors' guards in full.
 */
function byAlternatives(p: Pairing, alternatives: Alternative[]): Finding[] {
  const { spec, t, code, sites } = p;
  const entry = entryOf(t);
  const paths =
    sites.guardSets === undefined
      ? undefined
      : [
          ...new Map(
            sites.guardSets.map((s) => [setKey(s), [...new Set(s)].sort(compareStrings)]),
          ).values(),
        ].sort((a, b) => compareStrings(a.join(","), b.join(",")));
  const dominating = [...new Set(code.requires.map((g) => g.raw))].sort(compareStrings);
  const findings: Finding[] = [];
  for (const passed of paths ?? [dominating]) {
    const has = new Set(passed);
    const ranked = alternatives
      .map((a, i) => ({ actor: a.actor, i, missing: a.guards.filter((g) => !has.has(g.raw)) }))
      .sort((a, b) => a.missing.length - b.missing.length || a.i - b.i);
    const closest = ranked[0];
    if (closest === undefined || closest.missing.length === 0) continue;
    const need = ranked
      .map((a) => `${a.missing.map((g) => g.raw).join(" and ")} to act as ${a.actor}`)
      .join(", or ");
    const calls = ranked
      .map((a) => `${a.missing.map((g) => callOf(spec, g.raw)).join(" and ")} (as ${a.actor})`)
      .join(" or ");
    const set = `{${passed.join(", ")}}`;
    const message =
      paths === undefined
        ? `${t.name}: ${entry} may reach the write without passing all of one listed actor's ` +
          `guards (${passed.length === 0 ? "no guard is" : `only ${set} is`} called on every path); ` +
          `it must pass ${need}.`
        : `${t.name}: ${entry} reaches the write on a path that passes ` +
          `${passed.length === 0 ? "no guard" : `only ${set}`}; it must pass ${need}.`;
    const closestRaws = new Set(closest.missing.map((g) => g.raw));
    const partial = earliest(
      sites.guards.filter((g) => closestRaws.has(g.guard) && !g.dominates).map((g) => g.at),
    );
    const specAt = closest.missing.find((g) => g.at !== undefined)?.at;
    findings.push(
      pairingFinding(p, {
        category: "guard-not-dominating",
        severity: "error",
        subject: paths === undefined ? "path:*" : `path:{${passed.join(",")}}`,
        message,
        hint: `Call ${calls} on every path from ${entry} to the write, before any early return.`,
        ...(specAt === undefined ? {} : { specAt }),
        codeAt: partial ?? sites.write,
      }),
    );
  }
  return findings;
}
