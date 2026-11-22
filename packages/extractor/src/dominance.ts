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
 */
import type { ts } from "ts-morph";
import { type Callees, frameCalls, type Reach } from "./callgraph";
import { buildCfg, type Cfg, ENTRY, EXIT, type FunctionLike, reachable } from "./cfg";

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
export type GuardMatcher = (call: ts.CallExpression) => readonly string[];

export interface GuardSite {
  key: string;
  /** The guard call (or guard-wrapper call) on a path to the write. */
  call: ts.CallExpression;
}

export interface GuardFacts {
  /** Keys that dominate the write. */
  dominating: Set<string>;
  /** Guard calls on some path to the write, in frame order then source order. */
  sites: GuardSite[];
}

interface LeadGroup {
  node: ts.Node;
  callee?: FunctionLike;
}

export class Dominance {
  private readonly must = new Map<FunctionLike, Map<string, boolean>>();

  constructor(
    private readonly callees: Callees,
    private readonly isStop: (call: ts.CallExpression) => boolean,
    private readonly match: GuardMatcher,
    private readonly keys: readonly string[],
  ) {}

  /** Keys a call satisfies: direct matches plus wrappers that must call the guard. */
  keysOfCall(call: ts.CallExpression): string[] {
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

  /** Guard facts for `write` (in frame `writeFrame`) as reached from `root`. */
  analyze(root: Reach, writeFrame: FunctionLike, write: ts.Node): GuardFacts {
    const leadsMemo = new Map<FunctionLike, LeadGroup[]>();
    const leads = (fn: FunctionLike, stack: Set<FunctionLike>): LeadGroup[] => {
      const cached = leadsMemo.get(fn);
      if (cached) return cached;
      if (stack.has(fn)) return [];
      stack.add(fn);
      const groups: LeadGroup[] = fn === writeFrame ? [{ node: write }] : [];
      for (const e of root.edges) {
        if (e.caller !== fn) continue;
        if (leads(e.callee, stack).length > 0) groups.push({ node: e.call, callee: e.callee });
      }
      stack.delete(fn);
      leadsMemo.set(fn, groups);
      return groups;
    };

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
      for (const g of leads(fn, new Set())) {
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
    if (leads(root.root, new Set()).length > 0) {
      for (const key of this.keys) if (dominates(root.root, key, new Set())) dominating.add(key);
    }

    const sites: GuardSite[] = [];
    const visited = new Set<FunctionLike>();
    const collect = (fn: FunctionLike): void => {
      if (visited.has(fn)) return;
      visited.add(fn);
      const groups = leads(fn, new Set());
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
    return { dominating, sites };
  }
}
