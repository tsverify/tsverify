<!-- tsv-diff -->
## Behavior diff

`HEAD~1` → HEAD: 2 of 2 behavior files changed.

### Order lifecycle · removed

`a.behavior.yaml` · −6 states, −5 transitions, −4 actors, −3 rules, −8 bindings

```mermaid
flowchart LR
  start(("start"))
  draft("− draft")
  pending_payment("− pending_payment")
  paid("− paid")
  shipped(["− shipped"])
  refunded(["− refunded"])
  cancelled(["− cancelled"])
  start --> draft
  draft -.->|"− checkout · customer (owner)"| pending_payment
  pending_payment -.->|"− expire · system · after 30m"| cancelled
  pending_payment -.->|"− payment_succeeded · stripe · ⟳ idempotent · email.receipt ×1"| paid
  paid -.->|"− refund · admin · stripe.refund ×1"| refunded
  paid -.->|"− ship · admin"| shipped
  linkStyle 1,2,3,4,5 stroke:#dc2626,stroke-width:3px
  classDef removed fill:#fee2e2,stroke:#dc2626,stroke-width:2px,stroke-dasharray:4 3,color:#111827
  class draft,pending_payment,paid,shipped,refunded,cancelled removed
```

<sub>+ added · − removed · ~ changed · thick arrow: added · dotted arrow: removed · stadium: terminal state</sub>

<details><summary>Everything the removed file declares</summary>

**Behavior**

| | Field | Change |
|---|---|---|
| − | `behavior` | `Order lifecycle` |
| − | `name` | `Order` |
| − | `state` | `status` |
| − | `initial` | `draft` |

**States**

| | State | Change |
|---|---|---|
| − | `cancelled` | terminal: `yes` |
| − | `draft` | removed |
| − | `paid` | removed |
| − | `pending_payment` | removed |
| − | `refunded` | terminal: `yes` |
| − | `shipped` | terminal: `yes` |

**Transitions**

| | Transition | Change |
|---|---|---|
| − | `checkout` | from: `draft`<br>to: `pending_payment`<br>by: `customer`<br>requires: `owner`<br>atomic: `yes`<br>impl: `src/orders/checkout.ts#checkout`<br>concurrency: `2` |
| − | `expire` | from: `pending_payment`<br>to: `cancelled`<br>by: `system`<br>atomic: `yes`<br>after: `30m`<br>impl: `src/jobs/expire-orders.ts#expireOrder`<br>concurrency: `2` |
| − | `payment_succeeded` | from: `pending_payment`<br>to: `paid`<br>by: `stripe`<br>effects: `email.receipt (exactly-once)`<br>atomic: `yes`<br>idempotent: `yes`<br>impl: `src/payments/webhook.ts#onPaymentSucceeded`<br>concurrency: `2` |
| − | `refund` | from: `paid`<br>to: `refunded`<br>by: `admin`<br>effects: `stripe.refund (exactly-once)`<br>atomic: `yes`<br>impl: `src/orders/refund.ts#refundOrder`<br>concurrency: `2` |
| − | `ship` | from: `paid`<br>to: `shipped`<br>by: `admin`<br>atomic: `yes`<br>impl: `src/admin/orders.ts#shipOrder`<br>concurrency: `2` |

**Actors**

| | Actor | Change |
|---|---|---|
| − | `admin` | trust: `authenticated`<br>requires: `role(admin)` |
| − | `customer` | trust: `untrusted` |
| − | `stripe` | trust: `signed-webhook` |
| − | `system` | trust: `internal` |

**Rules**

| | Rule | Change |
|---|---|---|
| − | `Refund issued at most once per order` | kind: `always`<br>expr: `count(effect stripe.refund) <= 1` |
| − | `Shipped orders are never refunded` | kind: `never`<br>expr: `status == shipped and count(effect stripe.refund) > 0` |
| − | `Unpaid orders don't linger` | kind: `eventually`<br>expr: `status != pending_payment` |

**Bindings**

| | Binding | Change |
|---|---|---|
| − | `client:db` | `src/db.ts#db` |
| − | `client:email` | `src/notify/email.ts#email` |
| − | `client:stripe` | `src/payments/stripe.ts#stripe` |
| − | `effect:email.receipt` | `email.send` |
| − | `effect:stripe.refund` | `stripe.refunds.create` |
| − | `guard:owner` | `src/auth/guards.ts#requireOwner` |
| − | `guard:role(admin)` | `src/auth/guards.ts#requireRole("admin")` |
| − | `persistence` | `assign` |

</details>

### Ticket: support \#1 · added

`b.behavior.yaml` · +4 states, +3 transitions, +2 actors, +1 rule

```mermaid
flowchart LR
  start(("start"))
  open("+ open")
  on_hold_2("+ on-hold")
  on_hold("+ on_hold")
  s_end(["+ end"])
  start --> open
  open ==>|"+ close · agent"| s_end
  on_hold_2 ==>|"+ close · agent"| s_end
  open ==>|"+ hold#58; see #35;42 · agent (team(a#59;b)) · notify#60;ops#62; ×n"| on_hold_2
  on_hold_2 ==>|"+ page · ops#58;pager · ⟳ idempotent · pager#123;duty#125; ⟳"| on_hold
  linkStyle 1,2,3,4 stroke:#16a34a,stroke-width:3px
  classDef added fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#111827
  class open,on_hold_2,on_hold,s_end added
```

<sub>+ added · − removed · ~ changed · thick arrow: added · dotted arrow: removed · stadium: terminal state</sub>

<details><summary>Everything the added file declares</summary>

**Behavior**

| | Field | Change |
|---|---|---|
| + | `behavior` | `Ticket: support #1` |
| + | `name` | `SupportTicket` |
| + | `state` | `status` |
| + | `initial` | `open` |

**States**

| | State | Change |
|---|---|---|
| + | `end` | terminal: `yes` |
| + | `on-hold` | added |
| + | `on_hold` | added |
| + | `open` | added |

**Transitions**

| | Transition | Change |
|---|---|---|
| + | `close` | from: `on-hold, open`<br>to: `end`<br>by: `agent`<br>atomic: `yes`<br>concurrency: `1` |
| + | `hold: see #42` | from: `open`<br>to: `on-hold`<br>by: `agent`<br>requires: `team(a;b)`<br>effects: `notify<ops> (at-least-once)`<br>atomic: `yes`<br>concurrency: `1` |
| + | `page` | from: `on-hold`<br>to: `on_hold`<br>by: `ops:pager`<br>effects: `pager{duty} (idempotent)`<br>atomic: `yes`<br>idempotent: `yes`<br>concurrency: `1` |

**Actors**

| | Actor | Change |
|---|---|---|
| + | `agent` | trust: `authenticated` |
| + | `ops:pager` | trust: `internal` |

**Rules**

| | Rule | Change |
|---|---|---|
| + | `Closed tickets stay paged at most once` | kind: `always`<br>expr: `status == end implies count(effect pager{duty}) <= 1` |

</details>
