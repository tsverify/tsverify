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

/**
 * A reviewed change to the Order model, for diff tests: `refund` made non-atomic (B6), a new
 * `on_hold` state with `hold` / `release` transitions, `ship` also allowed from `on_hold`,
 * `expire` and the liveness rule removed, a changed effect binding, and `enforced: true`.
 */
export function orderDiffHead(): BehaviorModel {
  const base = orderModel();
  const admin = { by: ["admin"], requires: [], effects: [], atomic: true, idempotent: false };
  const transitions: Transition[] = [
    ...base.transitions
      .filter((t) => t.name !== "expire")
      .map((t) => {
        if (t.name === "refund") return { ...t, atomic: false };
        if (t.name === "ship") return { ...t, from: ["paid", "on_hold"] };
        return t;
      }),
    { ...admin, name: "hold", from: ["paid"], to: "on_hold" },
    { ...admin, name: "release", from: ["on_hold"], to: "paid" },
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  const { expire: _, ...concurrency } = base.concurrency;
  return {
    ...base,
    enforced: true,
    entity: { ...base.entity, states: [...base.entity.states, "on_hold"] },
    transitions,
    rules: base.rules.filter((r) => r.kind !== "eventually"),
    concurrency: { ...concurrency, hold: 1, release: 1 },
    bindings: {
      ...base.bindings,
      effects: { ...base.bindings.effects, "stripe.refund": "stripe.refunds.createV2" },
    },
  };
}
