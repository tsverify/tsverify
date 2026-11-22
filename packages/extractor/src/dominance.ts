/**
 * Guard-dominates-write analysis.
 *
 * A guard key (`role(admin)`) **dominates** a write when every path from the impl's entry to the
 * write passes a call of that guard, across the impl → helper calls that lead to the write.
 * Within one frame this is CFG reachability: the write is dominated when it is unreachable from
 * entry once the guard's call nodes are removed. Across frames: at each call that leads to the
 * write, either the guard dominates that call in the caller, or it dominates the write inside the
 * callee, for **every** such call (so a helper with one guarded and one unguarded call site is
 * not dominated).
 *
 * A guard call is a call whose callee resolves to the binding's function **and** whose literal
 * arguments equal the binding's args (`requireRole(actor, "admin")` is `role(admin)`;
 * `requireRole(actor, "support")` is not). A call to a project function that calls the guard on
 * every path to its normal return (a wrapper such as `assertAdmin(ctx)`) counts as a guard call.
 *
 * **Guard sets** (`CodeSites.guardSets`): the distinct sets of keys passed on the paths from the
 * impl's entry to the write, across the same frames. Within a frame this is a forward dataflow
 * over the CFG whose facts are sets of key bitmasks: entry holds `{0}`, completing a guard call
 * node ORs its keys in, joins take the union. A call into another project function ORs in each
 * of the sets that function passes on its way to a normal return, so a must-call wrapper counts
 * as its guard (as above) and a helper that calls one guard or another contributes both
 * alternatives. A call is passed only once it completes (its throw edge leaves from before the
 * call node), so a guard swallowed by a `catch` adds a set without it. Across frames, at each
 * call that leads to the write, every set that reaches the call is combined (OR) with every set
 * inside the callee from its entry to the write; a recursive re-entry adds no new path. A key
 * dominates exactly when it is in every set.
 */
import { compareStrings } from "@tsverify/ir";
import type * as TS from "@typescript/typescript6";
import { type Callees, frameCalls, type LeadGroup, leadsTo, type Reach } from "./callgraph";
import { buildCfg, type Cfg, ENTRY, EXIT, type FunctionLike, reachable } from "./cfg";

/**
 * Most distinct guard sets enumerated for one write (and at any CFG node on the way). Beyond
 * that, `guardSets` is left absent and conformance falls back to `guards[].dominates`: with
 * more than six keys the combinations grow exponentially and stop being a useful answer anyway.
 */
export const MAX_GUARD_SETS = 64;
/** Keys are bits of a 32-bit integer mask; more keys than this leave `guardSets` absent too. */
const MAX_MASK_KEYS = 30;

const cfgMemo = new WeakMap<FunctionLike, Cfg>();

export function cfgOf(fn: FunctionLike): Cfg {
  let cfg = cfgMemo.get(fn);
  if (!cfg) {
    cfg = buildCfg(fn);
    cfgMemo.set(fn, cfg);
  }
  return cfg;
}

/** Direct guard matches of a call: the binding keys it satisfies. */
export type GuardMatcher = (call: TS.CallExpression) => readonly string[];

export interface GuardSite {
  key: string;
  /** The guard call (or guard-wrapper call) on a path to the write. */
  call: TS.CallExpression;
}

export interface GuardFacts {
  /** Keys that dominate the write. */
  dominating: Set<string>;
  /** Guard calls on some path to the write, in frame order then source order. */
  sites: GuardSite[];
  /**
   * The distinct key sets passed on the paths to the write: each set sorted, the list sorted and
   * deduplicated (`[]` = no path reaches the write). Undefined when there are too many to
   * enumerate (`MAX_GUARD_SETS`).
   */
  sets?: string[][];
}

/** Element-wise string comparison; a prefix sorts first (`[]` before `["owner"]`). */
function compareKeyLists(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareStrings(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export class Dominance {
  private readonly must = new Map<FunctionLike, Map<string, boolean>>();
  /** Per frame: the key-mask sets reaching each CFG node from entry; null = over the cap. */
  private readonly pathSetsMemo = new Map<FunctionLike, readonly ReadonlySet<number>[] | null>();
  private readonly inProgress = new Set<FunctionLike>();

  constructor(
    private readonly callees: Callees,
    private readonly isStop: (call: TS.CallExpression) => boolean,
    private readonly match: GuardMatcher,
    private readonly keys: readonly string[],
  ) {}

  /** Keys a call satisfies: direct matches plus wrappers that must call the guard. */
  keysOfCall(call: TS.CallExpression): string[] {
    const direct = this.match(call);
    if (direct.length > 0) return [...direct];
    if (this.isStop(call)) return [];
    const callee = this.callees.of(call);
    return callee ? this.keys.filter((k) => this.mustCall(callee, k)) : [];
  }

  private guardNodes(fn: FunctionLike, key: string): Set<number> {
    const cfg = cfgOf(fn);
    const out = new Set<number>();
    for (const call of frameCalls(fn)) {
      if (this.keysOfCall(call).includes(key)) for (const id of cfg.idsOf(call)) out.add(id);
    }
    return out;
  }

  /** Every path from `fn`'s entry to its normal return passes a `key` guard call. */
  mustCall(fn: FunctionLike, key: string): boolean {
    let perKey = this.must.get(fn);
    if (!perKey) {
      perKey = new Map();
      this.must.set(fn, perKey);
    }
    const known = perKey.get(key);
    if (known !== undefined) return known;
    perKey.set(key, false); // recursion: assume it does not
    const seen = reachable(cfgOf(fn), [ENTRY], this.guardNodes(fn, key));
    const result = seen[EXIT] === 0;
    perKey.set(key, result);
    return result;
  }

  /**
   * What completing a call passes, as key-mask sets (undefined: nothing). A direct guard match is
   * one set of its keys. A call into a project function passes that function's sets at its normal
   * return: every one of a must-call wrapper's contains the key, and a helper doing
   * `if (admin) requireRole(…) else requireOwner(…)` passes either alternative. Null: over the cap.
   */
  private callSets(call: TS.CallExpression): ReadonlySet<number> | null | undefined {
    const direct = this.match(call);
    if (direct.length > 0) {
      let mask = 0;
      for (const key of direct) mask |= 1 << this.keys.indexOf(key);
      return new Set([mask]);
    }
    if (this.isStop(call)) return undefined;
    const callee = this.callees.of(call);
    // Recursion: assume the re-entered call passes nothing, as `mustCall` does.
    if (!callee || this.inProgress.has(callee)) return undefined;
    const sets = this.pathSets(callee);
    if (!sets) return null;
    const atReturn = sets[EXIT] as ReadonlySet<number>;
    return atReturn.size === 1 && atReturn.has(0) ? undefined : atReturn;
  }

  /**
   * The key-mask sets on the paths from `fn`'s entry to just before each CFG node (forward
   * dataflow, union at joins). Null when some node collects more than `MAX_GUARD_SETS`.
   */
  private pathSets(fn: FunctionLike): readonly ReadonlySet<number>[] | null {
    const known = this.pathSetsMemo.get(fn);
    if (known !== undefined) return known;
    this.inProgress.add(fn);
    const result = this.computePathSets(fn);
    this.inProgress.delete(fn);
    this.pathSetsMemo.set(fn, result);
    return result;
  }

  private computePathSets(fn: FunctionLike): Set<number>[] | null {
    const cfg = cfgOf(fn);
    const transfer = new Map<number, ReadonlySet<number>>();
    for (const call of frameCalls(fn)) {
      const t = this.callSets(call);
      if (t === null) return null;
      if (t !== undefined) for (const id of cfg.idsOf(call)) transfer.set(id, t);
    }
    const before: Set<number>[] = cfg.nodes.map(() => new Set());
    (before[ENTRY] as Set<number>).add(0);
    const queued = new Uint8Array(cfg.nodes.length);
    const work = [ENTRY];
    queued[ENTRY] = 1;
    const identity: ReadonlySet<number> = new Set([0]);
    while (work.length > 0) {
      const n = work.pop() as number;
      queued[n] = 0;
      const passes = transfer.get(n) ?? identity;
      for (const s of before[n] as Set<number>) {
        for (const t of passes) {
          const out = s | t;
          for (const m of cfg.succ[n] ?? []) {
            const into = before[m] as Set<number>;
            if (into.has(out)) continue;
            into.add(out);
            if (into.size > MAX_GUARD_SETS) return null;
            if (!queued[m]) {
              queued[m] = 1;
              work.push(m);
            }
          }
        }
      }
    }
    return before;
  }

  /** `GuardFacts.sets` for a write whose lead nodes are given by `leads`. */
  private guardSets(root: Reach, leads: (fn: FunctionLike) => LeadGroup[]): string[][] | undefined {
    if (this.keys.length > MAX_MASK_KEYS) return undefined;
    const memo = new Map<FunctionLike, ReadonlySet<number> | null>();
    const setsTo = (fn: FunctionLike, stack: Set<FunctionLike>): ReadonlySet<number> | null => {
      const cached = memo.get(fn);
      if (cached !== undefined) return cached;
      if (stack.has(fn)) return new Set(); // a recursive re-entry adds no new path
      stack.add(fn);
      let out: Set<number> | null = new Set();
      const before = this.pathSets(fn);
      if (!before) out = null;
      const cfg = cfgOf(fn);
      for (const g of before ? leads(fn) : []) {
        const inner = g.callee ? setsTo(g.callee, stack) : new Set([0]);
        if (!inner || !out) {
          out = null;
          break;
        }
        for (const id of cfg.idsOf(g.node)) {
          for (const a of before?.[id] ?? []) for (const b of inner) out.add(a | b);
        }
        if (out.size > MAX_GUARD_SETS) {
          out = null;
          break;
        }
      }
      stack.delete(fn);
      memo.set(fn, out);
      return out;
    };
    const masks = setsTo(root.root, new Set());
    if (!masks) return undefined;
    return [...masks]
      .map((mask) => this.keys.filter((_, i) => mask & (1 << i)).sort(compareStrings))
      .sort(compareKeyLists);
  }

  /** Guard facts for `write` (in frame `writeFrame`) as reached from `root`. */
  analyze(root: Reach, writeFrame: FunctionLike, write: TS.Node): GuardFacts {
    const leads = leadsTo(root, writeFrame, write);

    const domMemo = new Map<string, boolean>();
    const dominates = (fn: FunctionLike, key: string, stack: Set<FunctionLike>): boolean => {
      const memoKey = `${root.frames.indexOf(fn)}:${key}`;
      const cached = domMemo.get(memoKey);
      if (cached !== undefined) return cached;
      if (stack.has(fn)) return true; // a recursive re-entry adds no new path prefix
      stack.add(fn);
      const cfg = cfgOf(fn);
      const guards = this.guardNodes(fn, key);
      let result = true;
      for (const g of leads(fn)) {
        const ids = cfg.idsOf(g.node);
        const blocked = new Set(guards);
        for (const id of ids) blocked.delete(id);
        const seen = reachable(cfg, [ENTRY], blocked);
        if (!ids.some((id) => seen[id] === 1)) continue;
        if (g.callee && dominates(g.callee, key, stack)) continue;
        result = false;
        break;
      }
      stack.delete(fn);
      domMemo.set(memoKey, result);
      return result;
    };

    const dominating = new Set<string>();
    if (leads(root.root).length > 0) {
      for (const key of this.keys) if (dominates(root.root, key, new Set())) dominating.add(key);
    }

    const sites: GuardSite[] = [];
    const visited = new Set<FunctionLike>();
    const collect = (fn: FunctionLike): void => {
      if (visited.has(fn)) return;
      visited.add(fn);
      const groups = leads(fn);
      if (groups.length === 0) return;
      const cfg = cfgOf(fn);
      const fromEntry = reachable(cfg, [ENTRY]);
      const targets = groups.flatMap((g) => [...cfg.idsOf(g.node)]);
      for (const call of frameCalls(fn)) {
        const keys = this.keysOfCall(call);
        if (keys.length === 0) continue;
        const ids = cfg.idsOf(call);
        if (!ids.some((id) => fromEntry[id] === 1)) continue;
        const after = reachable(cfg, ids);
        if (!targets.some((t) => after[t] === 1)) continue;
        for (const key of keys) sites.push({ key, call });
      }
      for (const g of groups) if (g.callee) collect(g.callee);
    };
    collect(root.root);
    const sets = this.guardSets(root, leads);
    return { dominating, sites, ...(sets ? { sets } : {}) };
  }
}
