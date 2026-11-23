**Order lifecycle**. A customer checks out and pays; an admin ships or refunds; unpaid orders expire. An order has 6 states: draft, pending_payment, paid, shipped, refunded and cancelled. It starts as draft and ends as shipped, refunded or cancelled.

**Transitions**

- **checkout**: a customer (untrusted, requires owner) can move a draft order to pending_payment. This is atomic.
- **expire**: the system actor can move a pending_payment order to cancelled after 30m. This is atomic.
- **payment_succeeded**: a stripe webhook can move a pending_payment order to paid. This issues email.receipt exactly once, is atomic and tolerates duplicate delivery (idempotent).
- **refund**: an admin (requires role(admin)) can move a paid order to refunded. This issues stripe.refund exactly once and is atomic.
- **ship**: an admin (requires role(admin)) can move a paid order to shipped. This is atomic.

**Rules**

- **Refund issued at most once per order.** Always: stripe.refund has happened at most once. `count(effect stripe.refund) <= 1`
- **Unpaid orders don't linger.** Eventually: the order is not pending_payment. `status != pending_payment`
- **Shipped orders are never refunded.** Never: the order is shipped and stripe.refund has happened. `status == shipped and count(effect stripe.refund) > 0`
