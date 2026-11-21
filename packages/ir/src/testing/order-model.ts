import type { BehaviorModel } from "../model";

/**
 * The canonical Order model, equal to `packages/spec/test/fixtures/valid/order.behavior.yaml`
 * after parsing and normalisation (minus `at` locations and `file`). Shared by tests in every
 * package so no package hand-builds its own copy. Returns a fresh object on every call.
 */
export function orderModel(): BehaviorModel {
  return {
    kind: "entity",
    name: "Order lifecycle",
    summary: "A customer checks out and pays; an admin ships or refunds; unpaid orders expire.",
    origin: "spec",
    entity: {
      name: "Order",
      stateField: "status",
      states: ["draft", "pending_payment", "paid", "shipped", "refunded", "cancelled"],
      initial: "draft",
      terminal: ["shipped", "refunded", "cancelled"],
    },
    actors: {
      customer: { name: "customer", trust: "untrusted", requires: [] },
      admin: {
        name: "admin",
        trust: "authenticated",
        requires: [{ name: "role", args: ["admin"], raw: "role(admin)" }],
      },
      stripe: { name: "stripe", trust: "signed-webhook", requires: [] },
      system: { name: "system", trust: "internal", requires: [] },
    },
    transitions: [
      {
        name: "checkout",
        from: ["draft"],
        to: "pending_payment",
        by: ["customer"],
        requires: [{ name: "owner", args: [], raw: "owner" }],
        effects: [],
        atomic: true,
        idempotent: false,
        impl: { file: "src/orders/checkout.ts", symbol: "checkout" },
      },
      {
        name: "expire",
        from: ["pending_payment"],
        to: "cancelled",
        by: ["system"],
        requires: [],
        effects: [],
        atomic: true,
        idempotent: false,
        after: "30m",
        impl: { file: "src/jobs/expire-orders.ts", symbol: "expireOrder" },
      },
      {
        name: "payment_succeeded",
        from: ["pending_payment"],
        to: "paid",
        by: ["stripe"],
        requires: [],
        effects: [{ name: "email.receipt", multiplicity: "exactly-once" }],
        atomic: true,
        idempotent: true,
        impl: { file: "src/payments/webhook.ts", symbol: "onPaymentSucceeded" },
      },
      {
        name: "refund",
        from: ["paid"],
        to: "refunded",
        by: ["admin"],
        requires: [],
        effects: [{ name: "stripe.refund", multiplicity: "exactly-once" }],
        atomic: true,
        idempotent: false,
        impl: { file: "src/orders/refund.ts", symbol: "refundOrder" },
      },
      {
        name: "ship",
        from: ["paid"],
        to: "shipped",
        by: ["admin"],
        requires: [],
        effects: [],
        atomic: true,
        idempotent: false,
        impl: { file: "src/admin/orders.ts", symbol: "shipOrder" },
      },
    ],
    rules: [
      {
        name: "Refund issued at most once per order",
        kind: "always",
        source: "count(effect stripe.refund) <= 1",
        expr: { type: "effect-count", effect: "stripe.refund", op: "<=", value: 1 },
      },
      {
        name: "Unpaid orders don't linger",
        kind: "eventually",
        source: "status != pending_payment",
        expr: { type: "status-cmp", op: "!=", value: "pending_payment" },
      },
      {
        name: "Shipped orders are never refunded",
        kind: "never",
        source: "status == shipped and count(effect stripe.refund) > 0",
        expr: {
          type: "and",
          left: { type: "status-cmp", op: "==", value: "shipped" },
          right: { type: "effect-count", effect: "stripe.refund", op: ">", value: 0 },
        },
      },
    ],
    concurrency: { checkout: 2, expire: 2, payment_succeeded: 2, refund: 2, ship: 2 },
    bindings: {
      persistence: "assign",
      clients: {
        db: { module: "src/db.ts", export: "db" },
        stripe: { module: "src/payments/stripe.ts", export: "stripe" },
        email: { module: "src/notify/email.ts", export: "email" },
      },
      guards: {
        owner: {
          file: "src/auth/guards.ts",
          symbol: "requireOwner",
          args: [],
          raw: "src/auth/guards.ts#requireOwner",
        },
        "role(admin)": {
          file: "src/auth/guards.ts",
          symbol: "requireRole",
          args: ["admin"],
          raw: 'src/auth/guards.ts#requireRole("admin")',
        },
      },
      effects: {
        "stripe.refund": "stripe.refunds.create",
        "email.receipt": "email.send",
      },
    },
  };
}
