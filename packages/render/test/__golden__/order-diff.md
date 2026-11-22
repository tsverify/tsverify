<!-- tsv-diff -->
## Behavior diff

`origin/main` → working tree: 1 of 2 behavior files changed.

### Order lifecycle · changed

`src/orders/order.behavior.yaml` · enforced · ~1 top-level field, +1 state, +2 transitions, −1 transition, ~2 transitions, −1 rule, ~1 binding

```mermaid
flowchart LR
  start(("start"))
  draft("draft")
  pending_payment("pending_payment")
  paid("paid")
  shipped(["shipped"])
  refunded(["refunded"])
  cancelled(["cancelled"])
  on_hold("+ on_hold")
  start --> draft
  draft -->|"checkout · customer (owner)"| pending_payment
  pending_payment -.->|"− expire · system · after 30m"| cancelled
  paid ==>|"+ hold · admin"| on_hold
  pending_payment -->|"payment_succeeded · stripe · ⟳ idempotent · email.receipt ×1"| paid
  paid -->|"~ refund · admin · stripe.refund ×1 · ⚠ non-atomic"| refunded
  on_hold ==>|"+ release · admin"| paid
  paid -->|"~ ship · admin"| shipped
  on_hold ==>|"+ ship · admin"| shipped
  linkStyle 3,6,8 stroke:#16a34a,stroke-width:3px
  linkStyle 2 stroke:#dc2626,stroke-width:3px
  linkStyle 5,7 stroke:#d97706,stroke-width:3px
  classDef added fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#111827
  class on_hold added
```

<sub>+ added · − removed · ~ changed · thick arrow: added · dotted arrow: removed · stadium: terminal state</sub>

**Behavior**

| | Field | Change |
|---|---|---|
| ~ | `enforced` | `no` → `yes` |

**States**

| | State | Change |
|---|---|---|
| + | `on_hold` | added |

**Transitions**

| | Transition | Change |
|---|---|---|
| − | `expire` | from: `pending_payment`<br>to: `cancelled`<br>by: `system`<br>atomic: `yes`<br>after: `30m`<br>impl: `src/jobs/expire-orders.ts#expireOrder`<br>concurrency: `2` |
| + | `hold` | from: `paid`<br>to: `on_hold`<br>by: `admin`<br>atomic: `yes`<br>concurrency: `1` |
| ~ | `refund` | atomic: `yes` → `no` |
| + | `release` | from: `on_hold`<br>to: `paid`<br>by: `admin`<br>atomic: `yes`<br>concurrency: `1` |
| ~ | `ship` | from: `paid` → `on_hold, paid` |

**Rules**

| | Rule | Change |
|---|---|---|
| − | `Unpaid orders don't linger` | kind: `eventually`<br>expr: `status != pending_payment` |

**Bindings**

| | Binding | Change |
|---|---|---|
| ~ | `effect:stripe.refund` | `stripe.refunds.create` → `stripe.refunds.createV2` |

Unchanged: `src/other.behavior.yaml`.
