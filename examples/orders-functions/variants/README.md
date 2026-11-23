# Seeded-bug variants (the app's own storage functions)

The order domain of [`examples/orders-app`](../../orders-app/variants/README.md), with its data
layer written as the app's own functions over a plain `Map` (`src/store/orders.ts`: `getOrder`,
`saveOrder`, the conditional save `updateStatusIf`; `src/store/transaction.ts`: `withTransaction`),
no ORM. The spec names them under `bindings.storage` instead of a preset:

```yaml
bindings:
  storage:
    read: src/store/orders.ts#getOrder
    save: src/store/orders.ts#saveOrder
    update:
      fn: src/store/orders.ts#updateStatusIf
      args: [key, from, to, patch]
      returns: entity
    atomic: src/store/transaction.ts#withTransaction
```

`checkout`, `ship` and `refund` read and save inside `withTransaction` (atomic **as declared**:
`tsverify check` says so); `payment_succeeded` and `expire` are one conditional save each.

The same overlay format as the other examples: each directory holds only the files it replaces
plus a `variant.json` manifest (validated by `parseManifest` in `examples/shared/materialize.ts`;
`test/materialize.ts` binds the shared helpers to this app). B1–B6 are the orders-app bugs written
in this style, and `tsverify check` reports the same finding ids for them as for the assign app.
B7 is specific to conditional saves.

| id | Replaces | What changed vs. clean | Expected findings |
|---|---|---|---|
| `b1-reopen` | `src/admin/orders.ts` | adds `reopenOrder` (admin, `withTransaction`, `paid → pending_payment`) next to `shipOrder` | `undeclared-transition` |
| `b2-guard-bypass` | `src/orders/refund.ts` | `refundOrder(ctx: { actor; internal? })` returns early through a local `issueRefund` helper when `ctx.internal` is set, skipping `requireRole("admin")` | `guard-not-dominating` (refund) |
| `b3-refund-race` | `src/orders/refund.ts` | no `withTransaction`: `getOrder` → status check → `await stripe.refunds.create` → assign → `saveOrder` | `non-atomic` (refund), `implementation-property` (effect-multiplicity, `stripe.refund`) |
| `b4-webhook-dup` | `src/payments/webhook.ts` | read and save inside `withTransaction` with no status check, so every delivery marks the order paid and sends the receipt | `from-state-unconstrained` (payment_succeeded), `implementation-property` (effect-multiplicity, `email.receipt`) |
| `b5-undeclared-effect` | `src/jobs/expire-orders.ts` | after the conditional save, an order with a `chargeId` gets `stripe.refunds.create` | `undeclared-effect` (expire) |
| `b6-spec-race` | `src/orders/order.behavior.yaml` | `refund` has `atomic: false`; the code is the clean code | `spec-property` (effect-multiplicity `stripe.refund`, and `rule:Refund issued at most once per order`) |
| `b7-unchecked-receipt` | `src/payments/webhook.ts` | the webhook calls `updateStatusIf` but sends the receipt whatever it returned | `non-atomic` (payment_succeeded), whose message says the receipt is not behind a check of the save's result, `implementation-property` (effect-multiplicity, `email.receipt`) |

`tsverify test` gives the assign app's results for B1–B6 (B3: the replay confirms the double
Stripe refund), and for B7 the replay confirms the second receipt. `test/variants.test.ts`
materializes and typechecks every variant, and shows that B3 and B7 really pay out or send twice.
The end-to-end suites (`test/check.e2e.test.ts`, with pretty goldens in `test/__golden__/`, and
`test/test-command.e2e.test.ts`) run `tsverify check` and `tsverify test` on each one.
