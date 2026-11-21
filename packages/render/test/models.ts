import type { BehaviorModel, Transition } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";

/** Test-only Order variants, derived from the canonical fixture. */

function withTransition(
  model: BehaviorModel,
  name: string,
  patch: Partial<Transition>,
): BehaviorModel {
  return {
    ...model,
    transitions: model.transitions.map((t) => (t.name === name ? { ...t, ...patch } : t)),
  };
}

/** The Order model with `refund` not atomic: two parallel refunds can both pass the check. */
export function nonAtomicRefundModel(): BehaviorModel {
  return withTransition(orderModel(), "refund", { atomic: false });
}

/**
 * An as-implemented (`origin: "code"`) Order model in which the extractor could not bound the
 * source state of `refund`, so it is reachable from any state.
 */
export function codeAnyStateModel(): BehaviorModel {
  return { ...withTransition(orderModel(), "refund", { from: "*" }), origin: "code" };
}

/** Names that need Mermaid escaping: `on-hold`, a keyword state, `:` and `#` in labels. */
export function escapingModel(): BehaviorModel {
  return {
    kind: "entity",
    name: "Ticket: support #1",
    summary: 'Tickets go "on hold" while waiting; <b>{urgent}</b> ones page ops; 100% handled.',
    origin: "spec",
    entity: {
      name: "SupportTicket",
      stateField: "status",
      states: ["open", "on-hold", "on_hold", "end"],
      initial: "open",
      terminal: ["end"],
    },
    actors: {
      agent: { name: "agent", trust: "authenticated", requires: [] },
      "ops:pager": { name: "ops:pager", trust: "internal", requires: [] },
    },
    transitions: [
      {
        name: "close",
        from: ["open", "on-hold"],
        to: "end",
        by: ["agent"],
        requires: [],
        effects: [],
        atomic: true,
        idempotent: false,
      },
      {
        name: "hold: see #42",
        from: ["open"],
        to: "on-hold",
        by: ["agent"],
        requires: [{ name: "team", args: ["a;b"], raw: "team(a;b)" }],
        effects: [{ name: "notify<ops>", multiplicity: "at-least-once" }],
        atomic: true,
        idempotent: false,
      },
      {
        name: "page",
        from: ["on-hold"],
        to: "on_hold",
        by: ["ops:pager"],
        requires: [],
        effects: [{ name: "pager{duty}", multiplicity: "idempotent" }],
        atomic: true,
        idempotent: true,
      },
    ],
    rules: [
      {
        name: "Closed tickets stay paged at most once",
        kind: "always",
        source: "status == end implies count(effect pager{duty}) <= 1",
        expr: {
          type: "implies",
          left: { type: "status-cmp", op: "==", value: "end" },
          right: { type: "effect-count", effect: "pager{duty}", op: "<=", value: 1 },
        },
      },
    ],
    concurrency: { close: 1, "hold: see #42": 1, page: 1 },
    bindings: { clients: {}, guards: {}, effects: {} },
  };
}
