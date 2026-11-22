# Seeded-bug variants (Prisma)

The same overlay format as [`examples/orders-app/variants`](../../orders-app/variants/README.md):
each directory holds only the files it replaces plus a `variant.json` manifest (validated by
`parseManifest` in `examples/shared/materialize.ts`; `test/materialize.ts` binds the shared helpers
to this app). B1–B6 are the orders-app bugs written the Prisma way, and `tsv check` reports the
same finding ids for them as for the assign app. B7 is Prisma-specific.

| id | Replaces | What changed vs. clean | Expected findings |
|---|---|---|---|
| `b1-reopen` | `src/admin/orders.ts` | adds `reopenOrder` (admin, conditional `update`, `paid → pending_payment`) next to `shipOrder` | `undeclared-transition` |
| `b2-guard-bypass` | `src/orders/refund.ts` | `refundOrder(ctx: { actor; internal? })` returns early through a local `issueRefund` helper when `ctx.internal` is set, skipping `requireRole("admin")` | `guard-not-dominating` (refund) |
| `b3-refund-race` | `src/orders/refund.ts` | `findUniqueOrThrow` → status check → `await stripe.refunds.create` → `update({ where: { id } })` with no status condition and no transaction | `non-atomic` (refund), `implementation-property` (effect-multiplicity, `stripe.refund`) |
| `b4-webhook-dup` | `src/payments/webhook.ts` | the webhook's `updateMany` has no `status` in its `where` (a blind update), so every delivery marks the order paid and sends the receipt | `from-state-unconstrained` (payment_succeeded), `implementation-property` (effect-multiplicity, `email.receipt`) |
| `b5-undeclared-effect` | `src/jobs/expire-orders.ts` | after cancelling, an order with a `chargeId` gets `stripe.refunds.create` | `undeclared-effect` (expire) |
| `b6-spec-race` | `src/orders/order.behavior.yaml` | `refund` has `atomic: false`; the code is the clean code | `spec-property` (effect-multiplicity `stripe.refund`, and `rule:Refund issued at most once per order`) |
| `b7-tx-read-committed` | `src/orders/refund.ts` | read, check and `update` inside `prisma.$transaction(async (tx) => …)` at the default isolation level | `non-atomic` (refund), whose message names the isolation level, `implementation-property` (effect-multiplicity, `stripe.refund`) |

`test/variants.test.ts` materializes and typechecks every variant, and shows that B3 and B7 really
pay out twice against the stand-in client. The end-to-end suites (`test/check.e2e.test.ts`,
`test/test-command.e2e.test.ts`) run `tsv check` and `tsv test` on each one.
