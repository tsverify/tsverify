# Seeded-bug variants

Each directory is an **overlay** on the clean app: it holds only the files it replaces, at the same
paths as in `examples/orders-app/`, plus a `variant.json` manifest. `test/materialize.ts` copies the
app (without `test/` and `variants/`) into a temporary directory and applies an overlay:

```ts
import { materialize } from "../test/materialize";

const app = await materialize("b3-refund-race"); // or materialize() for the clean app
try {
  // app.root has tsconfig.json, package.json and src/, with the overlay applied
} finally {
  await app.dispose();
}
```

Overlays are excluded from the root typecheck (they don't resolve in place). The app's tests
materialize every variant and typecheck it with `tsc --noEmit -p <root>/tsconfig.json`.

## Variants

| id | Replaces | What changed vs. clean | Expected findings |
|---|---|---|---|
| `b1-reopen` | `src/admin/orders.ts` | adds `reopenOrder` (admin, transactional, `paid → pending_payment`) next to `shipOrder` | `undeclared-transition` |
| `b2-guard-bypass` | `src/orders/refund.ts` | `refundOrder(ctx: { actor; internal? })` returns early through a local `issueRefund` helper when `ctx.internal` is set, skipping `requireRole("admin")`; the helper holds the unchanged transaction + Stripe call | `guard-not-dominating` (refund) |
| `b3-refund-race` | `src/orders/refund.ts` | no transaction: `db.orders.get` → status check → `await stripe.refunds.create` → assign → `db.orders.save` | `non-atomic` (refund), `implementation-property` (effect-multiplicity, `stripe.refund`) |
| `b4-webhook-dup` | `src/payments/webhook.ts` | the `status !== "pending_payment"` check and the early return are gone; the transaction always sets `paid` and the receipt is always sent | `from-state-unconstrained` (payment_succeeded), `implementation-property` (effect-multiplicity, `email.receipt`) |
| `b5-undeclared-effect` | `src/jobs/expire-orders.ts` | after the transaction commits, a cancelled order with a `chargeId` gets `stripe.refunds.create` | `undeclared-effect` (expire) |
| `b6-spec-race` | `src/orders/order.behavior.yaml` | `refund` has `atomic: false`; the code is the clean, atomic code | `spec-property` (effect-multiplicity `stripe.refund`, and `rule:Refund issued at most once per order`) |

## `variant.json`

```json
{
  "id": "b3-refund-race",
  "bug": "one line: what is wrong",
  "expected": [{ "category": "non-atomic", "transition": "refund", "file": "src/orders/refund.ts" }]
}
```

- `id` equals the directory name.
- `expected` is a **lower bound**: the end-to-end suite requires each listed finding. A bug can have
  knock-on findings (for example, B1 and B4 let the as-implemented model pay twice, so the receipt's
  effect-multiplicity can fire too); those are pinned by the e2e golden output, not here.
- Each entry matches only the fields it gives: `category` (a `FindingCategory` from `@tsverify/ir`),
  `transition` and `property` against the same `Finding` fields, `subject` against the
  `:<subject>` suffix of `Finding.id`, and `file` against `Finding.codeAt.file`.

`parseManifest` in `examples/shared/materialize.ts` (shared by every example app; `test/materialize.ts` binds it to this app) is the validator.

## Adding a variant

1. Create `variants/<id>/` with the replaced files at their app paths. Replace whole files; keep
   the rest of each file identical to the clean app so the diff shows only the bug.
2. Add `variant.json`.
3. Add the id to `VARIANTS` in `test/variants.test.ts`.
