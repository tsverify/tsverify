/**
 * Effect call discovery from `bindings.clients`: every call on a bound client in the frames an
 * impl reaches, except calls on persistence clients (the ones the adapter recognized as reads,
 * commits or scopes) and scope-opening calls. Bound calls are never descended into, so a fake
 * client's own implementation contributes nothing.
 *
 * The effect name is the spec name whose `bindings.effects` path equals the call's gate
 * (`stripe.refunds.create` → `stripe.refund`), or the gate itself when no binding maps it.
 */
import type { BehaviorModel, EffectMultiplicity, Transition } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";
import type { ts } from "ts-morph";
import { frameCalls, type Reach } from "./callgraph";
import type { ClientCall, ClientCalls } from "./client-calls";

export function effectCalls(
  reach: Reach,
  calls: ClientCalls,
  persistenceClients: ReadonlySet<string>,
): ClientCall[] {
  const out: ClientCall[] = [];
  const seen = new Set<ts.CallExpression>();
  for (const frame of reach.frames) {
    for (const call of frameCalls(frame)) {
      const cc = calls.classify(call);
      if (!cc || seen.has(call) || persistenceClients.has(cc.client)) continue;
      if (calls.isScopeOpener(call)) continue;
      seen.add(call);
      out.push(cc);
    }
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
