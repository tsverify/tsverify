<!-- tsverify-diff -->
## Behavior diff

`HEAD` → working tree: 1 of 1 behavior file changed.

### Order lifecycle · changed

`src/orders/order.behavior.yaml` · +1 transition, ~1 transition

```mermaid
flowchart LR
  start(("start"))
  draft("draft")
  pending_payment("pending_payment")
  paid("paid")
  shipped(["shipped"])
  refunded(["refunded"])
  cancelled(["cancelled"])
  start --> draft
  pending_payment ==>|"+ cancel · customer (owner)"| cancelled
  draft -->|"checkout · customer (owner)"| pending_payment
  pending_payment -->|"expire · system · after 30m"| cancelled
  pending_payment -->|"payment_succeeded · stripe · ⟳ idempotent · email.receipt ×1"| paid
  paid -->|"~ refund · admin · stripe.refund ×1 · ⚠ non-atomic"| refunded
  paid -->|"ship · admin"| shipped
  linkStyle 1 stroke:#16a34a,stroke-width:3px
  linkStyle 5 stroke:#d97706,stroke-width:3px
```

<sub>+ added · − removed · ~ changed · thick arrow: added · dotted arrow: removed · stadium: terminal state</sub>

**Transitions**

| | Transition | Change |
|---|---|---|
| + | `cancel` | from: `pending_payment`<br>to: `cancelled`<br>by: `customer`<br>requires: `owner`<br>atomic: `yes`<br>concurrency: `2` |
| ~ | `refund` | atomic: `yes` → `no` |
