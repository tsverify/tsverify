/**
 * Effect call discovery from `bindings.clients`: calls on a bound client in the frames an impl
 * reaches, except calls on persistence clients (the ones the adapter recognized as reads,
 * commits or scopes) and scope-opening calls. Bound calls are never descended into, so a fake
 * client's own implementation contributes nothing.
 *
 * **Attribution rule: effects on the write's path.** A call is attributed to the transition when
 * it can run on an execution that performs the write and then completes normally:
 * - in a frame that leads to the write (the write's frame, and each caller on the call path to
 *   it), a call that can reach a lead node (it runs **before** the write, on its path), or that
 *   is reachable from a lead node **without an exceptional edge** (it runs after the write, or
 *   after the helper or scope containing it returned normally: `return x` from the transaction,
 *   then `if (x === undefined) return; await email.send(…)`). Exceptional edges are a call or
 *   `throw` that did not complete, so a `catch` around the write (or around the helper call
 *   that leads to it) is not on the path, and neither is a branch that returns before the write;
 * - in any other frame, every call, when the frame is called from an attributed call site.
 *
 * Conservative where unsure: conditions are not evaluated (both branches stay possible), a call
 * with no CFG node counts, and a `finally` counts (its normal copy follows the write).
 *
 * The effect name is the spec name whose `bindings.effects` path equals the call's gate
 * (`stripe.refunds.create` → `stripe.refund`), or the gate itself when no binding maps it.
 */
import type { BehaviorModel, EffectMultiplicity, Transition } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";
import type { ts } from "ts-morph";
import { frameCalls, leadsTo, type Reach } from "./callgraph";
import { type Cfg, type FunctionLike, reachable } from "./cfg";
import type { ClientCall, ClientCalls } from "./client-calls";
import { cfgOf } from "./dominance";

/** Nodes that can reach one of `targets` (any edge). */
function reachingAny(cfg: Cfg, targets: readonly number[]): Uint8Array {
  const preds: number[][] = cfg.nodes.map(() => []);
  cfg.succ.forEach((succ, from) => {
    for (const to of succ) preds[to]?.push(from);
  });
  const seen = new Uint8Array(cfg.nodes.length);
  const stack = [...targets];
  for (const t of targets) seen[t] = 1;
  while (stack.length > 0) {
    const n = stack.pop() as number;
    for (const p of preds[n] ?? []) {
      if (seen[p]) continue;
      seen[p] = 1;
      stack.push(p);
    }
  }
  return seen;
}

/** Effect calls attributed to `write` (in `writeFrame`) as reached from `reach.root`. */
export function effectCalls(
  reach: Reach,
  writeFrame: FunctionLike,
  write: ts.Node,
  calls: ClientCalls,
  persistenceClients: ReadonlySet<string>,
): ClientCall[] {
  const leads = leadsTo(reach, writeFrame, write);
  const out: ClientCall[] = [];
  const seen = new Set<ts.CallExpression>();
  const whole = new Set<FunctionLike>();
  const pending: FunctionLike[] = [];
  const attribute = (fn: FunctionLike, call: ts.CallExpression): void => {
    for (const e of reach.edges) {
      if (e.caller === fn && e.call === call && !whole.has(e.callee)) {
        whole.add(e.callee);
        pending.push(e.callee);
      }
    }
    const cc = calls.classify(call);
    if (!cc || seen.has(call) || persistenceClients.has(cc.client)) return;
    if (calls.isScopeOpener(call)) return;
    seen.add(call);
    out.push(cc);
  };

  for (const fn of reach.frames) {
    const groups = leads(fn);
    if (groups.length === 0) continue;
    const cfg = cfgOf(fn);
    const leadIds = groups.flatMap((g) => [...cfg.idsOf(g.node)]);
    const leadNodes = new Set(groups.map((g) => g.node));
    const before = reachingAny(cfg, leadIds);
    const after = reachable(cfg, leadIds, cfg.throwTargets);
    for (const call of frameCalls(fn)) {
      if (leadNodes.has(call)) continue;
      const ids = cfg.idsOf(call);
      if (ids.length === 0 || ids.some((id) => before[id] === 1 || after[id] === 1)) {
        attribute(fn, call);
      }
    }
  }
  while (pending.length > 0) {
    const fn = pending.shift() as FunctionLike;
    for (const call of frameCalls(fn)) attribute(fn, call);
  }
  return out;
}

/**
 * Gate → effect name. When several names map to one gate, a name declared on `linked` wins, then
 * the first in name order.
 */
export function effectNameOf(gate: string, spec: BehaviorModel, linked?: Transition): string {
  const names = Object.entries(spec.bindings.effects)
    .filter(([, path]) => path === gate)
    .map(([name]) => name)
    .sort(compareStrings);
  if (names.length === 0) return gate;
  const declared = linked?.effects.find((e) => names.includes(e.name));
  return declared?.name ?? (names[0] as string);
}

/** Multiplicity from the spec's declaration of the effect: the linked transition first. */
export function multiplicityOf(
  name: string,
  spec: BehaviorModel,
  linked?: Transition,
): EffectMultiplicity {
  const own = linked?.effects.find((e) => e.name === name);
  if (own) return own.multiplicity;
  for (const t of spec.transitions) {
    const d = t.effects.find((e) => e.name === name);
    if (d) return d.multiplicity;
  }
  return "at-least-once";
}
