/**
 * `CallSite.occurrence`: how many calls with the same gate can run before this one within one
 * invocation of the impl. Counted per frame on the CFG (calls on mutually exclusive branches do
 * not count), plus, for a call inside a helper, the most counted at any of the helper's call
 * sites in its callers. Same-gate calls inside *other* helpers are not counted.
 */
import type { ts } from "ts-morph";
import { frameCalls, type Reach } from "./callgraph";
import { type FunctionLike, reachable } from "./cfg";
import type { ClientCalls } from "./client-calls";
import { cfgOf } from "./dominance";

function localCount(frame: FunctionLike, node: ts.Node, gate: string, calls: ClientCalls): number {
  const cfg = cfgOf(frame);
  const targets = cfg.idsOf(node);
  let n = 0;
  for (const call of frameCalls(frame)) {
    if (call === node || calls.classify(call)?.gate !== gate) continue;
    const seen = reachable(cfg, cfg.idsOf(call));
    if (targets.some((t) => seen[t] === 1)) n++;
  }
  return n;
}

export function occurrenceOf(
  call: ts.CallExpression,
  frame: FunctionLike,
  gate: string,
  reach: Reach,
  calls: ClientCalls,
): number {
  const visit = (fn: FunctionLike, node: ts.Node, stack: Set<FunctionLike>): number => {
    if (stack.has(fn)) return 0;
    stack.add(fn);
    let before = 0;
    for (const e of reach.edges) {
      if (e.callee === fn) before = Math.max(before, visit(e.caller, e.call, stack));
    }
    stack.delete(fn);
    return before + localCount(fn, node, gate, calls);
  };
  return visit(frame, call, new Set());
}
