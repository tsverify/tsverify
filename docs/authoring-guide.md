# Writing behavior specs

This guide is for coding agents and the people who work with them. With it and `tsverify --help`, you can write a
`*.behavior.yaml` spec for new or existing TypeScript code and have `tsverify check` verify it. Every key is listed in
the [format reference](behavior-format.md). CI setups are in [workflows](workflows.md).

There is no `tsverify infer`. You write the spec, and `tsverify` checks it against the code. For existing code, write the
spec for what the code **should** do, then let `tsverify check` tell you where the code does something else.

**Contents:** 1 [When and at which scope](#1-when-to-write-a-spec-and-at-which-scope) ·
2 [Anatomy](#2-anatomy-of-a-spec) · 3 [Commands and exit codes](#3-commands-and-exit-codes) ·
4 [Spec first (new code)](#4-spec-first-new-code) · 5 [As-is specs (existing code)](#5-as-is-specs-for-existing-code) ·
6 [Reading findings](#6-reading-findings) · 7 [Code shapes tsverify understands](#7-code-shapes-tsverify-understands) ·
8 [Fixtures for `tsverify test`](#8-fixtures-for-tsverify-test) · 9 [Editor support](#9-editor-support-json-schema) ·
10 [`enforced` and CI](#10-enforced-and-ci) · 11 [Common mistakes](#11-common-mistakes) ·
12 [Checklist](#12-checklist-before-you-open-the-pr)

---

## 1. When to write a spec, and at which scope

Write a spec when an entity has a **state field** (`status`, `state`, `phase`…) that more than one function
changes, and at least one of these is true:

| Signal in the code | What `tsverify` checks for you |
|---|---|
| Money, emails, or external API calls happen on a state change | each effect fires on the right transitions, and at most once if it is `exactly-once` |
| Read the state, check it, then write it, on a path concurrent requests can take | the check and the write are `atomic` |
| Webhooks, queue consumers, retries | redelivery is harmless (`idempotent`) |
| Different callers (customer, admin, webhook, cron) | each caller's guards run before the write |
| A transition that must never happen (refund after ship) | `rules` hold in every reachable state |

Skip it for stateless functions, CRUD without a lifecycle, and fields that only one function ever writes.

**Scope: entity first.** v1 has a single scope, `kind: entity`: one entity type, one state field, one file.
The function, flow, system and policy scopes are planned. If an entity has two independent state fields
(`status` and `fulfillment`), write two specs.

**Where:** put the spec next to the entity's type, named `<entity>.behavior.yaml` (`src/orders/order.behavior.yaml`).
It must sit inside the TypeScript project that contains the code. The project root is the nearest directory at or
above the spec that has a `tsconfig.json`, and every path in the spec is relative to it.

---

## 2. Anatomy of a spec

A complete spec, for the invoice code in [§5.3](#53-worked-example):

```yaml
# tsverify:example
behavior: Invoice lifecycle
summary: A customer finalizes a draft; the payment webhook marks it paid; an admin can void it.

entity:
  name: Invoice # the TypeScript type (or Prisma model) name
  state: status # the field that holds the state
  states: [draft, open, paid, void]
  initial: draft
  terminal: [paid, void]

actors:
  customer: { trust: untrusted }
  admin: { trust: authenticated, requires: role(admin) }
  provider: { trust: signed-webhook }

transitions:
  finalize:
    from: draft
    to: open
    by: customer
    requires: [owner]
    atomic: true
    impl: src/invoices/actions.ts#finalizeInvoice

  pay:
    from: open
    to: paid
    by: provider
    idempotent: true
    atomic: true
    effects:
      - email.receipt: exactly-once
    impl: src/invoices/actions.ts#onInvoicePaid

  void:
    from: [draft, open]
    to: void
    by: admin
    atomic: true
    effects: [payments.cancel]
    impl: src/invoices/actions.ts#voidInvoice

rules:
  - name: A paid invoice is never voided
    never: status == void and count(effect email.receipt) > 0

bindings:
  persistence: assign
  clients:
    db: { module: src/db.ts, export: db }
    email: { module: src/email.ts, export: email }
    payments: { module: src/payments.ts, export: payments }
  guards:
    owner: src/auth.ts#requireOwner
    role(admin): src/auth.ts#requireRole("admin")
  effects:
    email.receipt: email.send
    payments.cancel: payments.cancelIntent

fixtures:
  entity: { id: inv_1, ownerId: u1, email: u1@example.com }
  actors:
    customer: { id: u1, roles: [] }
    admin: { id: a1, roles: [admin] }
  args:
    pay: [{ invoiceId: $id }]
```

| Section | Answers | Comes from |
|---|---|---|
| `entity` | What has a lifecycle? | The type and its literal-union (or enum) state field |
| `actors` | Who can trigger changes, and how far do we trust them? | Route handlers, webhook handlers, jobs |
| `transitions` | Which state changes are allowed: from where, to where, by whom, with which guards and effects? | Every function that writes the state field |
| `rules` | What must always, never, or eventually be true? | Business invariants, written as rule expressions |
| `concurrency` | How many concurrent invocations to explore (default 2 per transition) | Raise it only for a specific race |
| `bindings` | Which code objects are the database, the effect clients, and the guards? | Imports used by the impls |
| `fixtures` | Which values `tsverify test` uses to call the real code | Test data |

Trust levels, and what `tsverify` does with each:

| `trust` | Use for | Built-in check |
|---|---|---|
| `untrusted` | End users, public endpoints | every transition it performs needs a guard (`untrusted-guarded`) |
| `authenticated` | Staff or service users whose identity is verified; authorization still needs a guard | none; put role guards in the actor's `requires` |
| `signed-webhook` | Verified third-party callbacks (Stripe, GitHub) | every transition it performs must be `idempotent: true` (`webhook-idempotent`) |
| `internal` | Cron jobs, queue workers, your own services | none |

**`by` lists alternatives.** `by: [customer, admin]` means *any one* of them may perform the transition. A call is
allowed when it passes the transition's own `requires` (which applies to every caller) and all the `requires` of
one listed actor. So `customer: { requires: owner }` and `admin: { requires: role(admin) }` give "the owner, or an
admin", and code shaped like `if (isAdmin) requireRole(actor, "admin"); else requireOwner(actor, order);`
conforms. Use one transition for it; there is no need to split it per actor. Guards that every caller must pass go
in the transition's `requires`. Details: [format reference](behavior-format.md#who-may-perform-a-transition-by-and-requires).

Rule expressions see only `status` and effect counts. They cover one entity instance, and effect counts cover
that instance's whole lifetime:

```yaml
rules:
  - name: Refund at most once
    always: count(effect stripe.refund) <= 1
  - name: Unpaid orders do not linger
    eventually: status != pending_payment
  - name: Shipped orders are never refunded
    never: status == shipped and count(effect stripe.refund) > 0
```

The grammar is `status == S`, `status != S`, `status in [S, …]`, `count(effect E) <op> N`, `true`, `false`,
`and`, `or`, `not`, `implies` and parentheses ([format reference](behavior-format.md#rules)). `always` and `never`
are checked in every reachable state. `eventually` is checked in every **end state**, where no transition can
fire any more: "the entity can't come to rest while this is false". A rule that only restates an `exactly-once`
effect (`count(effect E) <= 1`) adds nothing; the built-in check already covers it.

---

## 3. Commands and exit codes

| Command | Does | Use it |
|---|---|---|
| `tsverify validate [paths…]` | Parse and validate specs only | After every spec edit (fast) |
| `tsverify check --spec-only [paths…]` | Plus model-check the spec (design bugs, with counterexamples) | Before writing code |
| `tsverify check [paths…]` | Plus extract the code's behavior and compare | After writing code, and in CI (with `--strict` when it blocks) |
| `tsverify test [paths…]` | Generate and run vitest tests from spec + code (paths, forbidden transitions, guards, replays of counterexamples) | To confirm findings in the real code |
| `tsverify diff --base <ref> [paths…]` | Behavior diff against a git ref (Markdown + Mermaid) | In PRs |
| `tsverify render <spec> --mermaid\|--matrix\|--summary` | Diagram, permission matrix, plain-English summary | To review a spec |
| `tsverify schema` | Print the JSON Schema of `*.behavior.yaml` | Editor setup ([§9](#9-editor-support-json-schema)) |

Paths default to the current directory, which is searched for `**/*.behavior.yaml`. Add `--format json` when a
program reads the output: each finding has a stable `id`, plus `category`, `severity`, `message`, `hint`,
`specAt` and `codeAt`, and `causedBy` on a consequence; each spec has its checker and extractor statistics
([workflows.md](workflows.md#outputs-and-where-they-go) has the full shape). Locations are relative to the current
directory, so run `tsverify` from the repository root (as CI does); the pretty output shows a path outside the
current directory as an absolute path. Each spec's TypeScript project is still found on its own (the nearest
`tsconfig.json`). The summary line counts the states the model checker explored, for the spec and for the code's
model.

**Which project, and which of its files.** `impl` and binding paths are relative to the project root: the
directory of the nearest `tsconfig.json` above the spec. `--project <dir>` names it for every spec, and
`--project <dir>/tsconfig.<name>.json` names the tsconfig too, when the one to read isn't `tsconfig.json` (a
solution-style `tsconfig.json` that only lists `references`, say: `--project packages/x/tsconfig.src.json`). The
program holds the tsconfig's files and everything they import, which can include other workspace packages
resolved to their sources (through `paths` or `customConditions`). Only the project's **own files** are searched
for state writes no transition asked about (`undeclared-transition`, and `unanalyzable` warnings on such writes):
files under the project root, and files the tsconfig's own `files` / `include` name, wherever they are. A file
of another package counts only where an `impl` reaches it: its writes are then that transition's, like any
helper's. So a package's forwarding wrappers (`startAttempt(…) { return this.inner.startAttempt(…) }`) need no
binding to stay quiet.

`--strict` (on `check` and `test`) reports every `unanalyzable` warning as an error, so the run exits 1 when
`tsverify` could not analyze some of the code. Without it, reshaping code into a form `tsverify` can't read would
turn a finding into a passing warning. On `tsverify test` it also fails a transition with an `impl` that got no
generated test at all, and a spec that got none. Use it wherever `tsverify` blocks a merge
([workflows.md](workflows.md#--strict)).

| Exit | Meaning | What to do |
|---|---|---|
| `0` | No error-severity findings (warnings and info never fail a run) | Done. Still read the warnings |
| `1` | Violations: behavior bugs or conformance mismatches; with `--strict`, also `unanalyzable` warnings | Fix them ([§6](#6-reading-findings)) |
| `2` | Invalid input: bad spec, broken `impl`/client/guard link, bad CLI usage, no usable TypeScript ([§11](#11-common-mistakes)). Takes precedence over 1 | Fix the spec, the command or the install |
| `3` | Internal error in `tsverify` | Report it. Don't work around it by editing the spec |

---

## 4. Spec first (new code)

1. **Write the spec** next to where the entity's type will live: entity, actors, transitions with `from`, `to`,
   `by`, `requires`, `effects`, and `atomic: true` wherever the transition checks state before writing (almost
   always). Add `rules` for the invariants you care about. Bindings and `impl` can wait.
2. **`tsverify validate`**, then **`tsverify check --spec-only`**, until both exit 0. A `spec-property` finding here is a
   design bug, and it comes with a trace. Fix the design, not the rule.
3. **Implement**, in the shapes of [§7](#7-code-shapes-tsverify-understands): one exported function per transition,
   the state as a literal union, clients as imported module-level objects.
4. **Bind it:** add `impl` to every transition, plus `bindings.clients`, `bindings.guards` and `bindings.effects`.
5. **`tsverify check`** until it exits 0. Fix the code, not the spec ([§6](#6-reading-findings)).
6. **Add `fixtures`** and run **`tsverify test`** ([§8](#8-fixtures-for-tsverify-test)).
7. Commit the spec and code together. In the PR, explain the behavior, and let reviewers see `tsverify diff`.

---

## 5. As-is specs for existing code

> **The rule:** write the spec for what the code **should** do. The findings are your bug list. Never weaken a
> spec (widen `from`, drop a guard, an effect, `atomic` or a rule, relax `exactly-once`) just so `tsverify check`
> passes. If you are unsure what the intent is, keep the strict version and leave a note for a human. A finding is
> cheaper than a silent bug.

### 5.1 Step by step

| # | Step | How |
|---|---|---|
| 1 | **Find the entity and its state field** | Look for a `type XStatus = "a" \| "b" …` union, an `enum`, or a Prisma `enum` used by a model field. `entity.name` = the type name (`assign`, `memory`) or the Prisma model name (`prisma`). `entity.state` = the exact property name |
| 2 | **List the states from the type** | Copy every member of the union into `states`, in lifecycle order. `initial` = the value new records are created with (look at `create` calls or object literals; if there are none, the state the domain starts in, and ask a human). `terminal` = states nothing leaves |
| 3 | **Find every write and its function** | Write a skeleton spec (entity with **every** state of the type, one actor, `transitions: {}`, `bindings.storage` and `bindings.clients`) and run `tsverify check`. For `bindings.storage`, use a preset (`assign`, `prisma`, `memory`) when the code calls a repository object, a Prisma client or in-process objects directly; otherwise name the app's own read, save, conditional-save and transaction functions ([§7.6](#76-storage-point-at-your-own-functions)), whatever database is underneath (Drizzle, SQL, an HTTP API). Every write it recognizes is reported as `undeclared-transition: <function> writes <from> → <to>`, with the `impl` to use. Cross-check with grep ([§5.2](#52-find-writes-with-grep)): writes `tsverify` sees but can't read are listed as `unanalyzable` warnings instead, and a raw query that sets the state is not seen at all. Ignore the "remove the state" hints at this stage: they go away once transitions exist |
| 4 | **One transition per entry point** | Name it after the business event (`refund`, not `refundOrder`). `impl` = the exported function that callers invoke (route handler, job, webhook handler, service method: `file.ts#Class.method`). Helpers it calls (up to 8 levels deep) are followed. One entry point serving two kinds of caller (`cancelBooking(user, id, { support })`) becomes two transitions with the same `impl`, one per actor, so each gets its own guards |
| 5 | **Read the from-states off the guards** | The checks before the write: `if (x.status !== "paid") throw` → `from: paid`. The inventory from step 3 shows what the code currently allows. Write what it *should* allow. A write with no check at all gets the intended `from`, and `tsverify check` will report `from-state-unconstrained` |
| 6 | **Identify actors and trust** | Who calls each entry point: a logged-in end user (`untrusted`), staff (`authenticated` + a role guard in the actor's `requires`), a verified webhook (`signed-webhook`), a job or worker (`internal`). One actor per kind of caller |
| 7 | **Guards** | Functions that throw unless the caller is allowed, called before the write: `requireOwner(actor, order)`, `requireRole(actor, "admin")`. Guards for one actor go in its `requires`; guards for one transition go in the transition's `requires` (both take one guard or a list). A guard without arguments is just a name (`staff: src/auth.ts#assertStaff`). Quote a guard with several arguments inside `{ … }` or `[ … ]` (`requires: "role(owner, admin)"`): there a comma ends the value. A guard that *should* run but doesn't still goes in the spec. A caller-supplied flag that skips a guard (`if (!opts.admin) requireOwner(…)`) is a bypass: specify the guard anyway |
| 8 | **Effects and their multiplicity** | Calls on external clients on the transition's path: payments, email, queues, HTTP APIs. Name each effect by its meaning (`email.receipt`, `email.shipped`) and map names to calls in `bindings.effects`. The call path starts with a `bindings.clients` key (`email.send`), and the effect name is free. Two names may map to the same call. Multiplicity: `exactly-once` (default; money, emails) means at most once per entity, over its whole life; `at-least-once` means repeats are fine; `idempotent` means the receiver deduplicates |
| 9 | **`atomic`** | `atomic: true` when the read, the state check and the write must not interleave with another request. That is almost every transition that checks the state. Code that achieves it: a transaction callback, a conditional update (`updateMany({ where: { id, status: "paid" } })`), or, in memory, no `await` between the check and the write ([§7](#7-code-shapes-tsverify-understands)). Set it when the code *should* be atomic, even if it isn't |
| 10 | **`idempotent`** | `idempotent: true` for transitions that can be delivered more than once (webhooks, queues with retries). The code must make redelivery harmless, usually through the from-state check |
| 11 | **Rules** | The invariants a reviewer would state in words: "refund at most once", "a shipped order is never refunded", "unpaid orders do not linger" |
| 12 | **Bind** | `bindings.storage`: a preset (`assign`, `prisma` or `memory`), or the app's own storage functions (`read`, `save`, `update`, `atomic`, [§7.6](#76-storage-point-at-your-own-functions)); `bindings.clients` (the database client for a preset, and every effect client: `{ module, export }`), `bindings.guards` (`name: path#function` or `name(arg): path#function("arg")`), `bindings.effects` (effect name → `client.member.path`) |
| 13 | **Run `tsverify validate`, `tsverify check --spec-only`, then `tsverify check`** | `--spec-only` first separates design bugs (in the spec) from code bugs. Exit 2: fix the spec or the links first. Exit 1: triage each finding with [§6](#6-reading-findings). For each finding, either fix the code, or confirm with a human that the intent is different and change the spec, saying why in the PR |
| 14 | **Add fixtures and run `tsverify test`** | Replays turn counterexamples into failing tests against the real code ([§8](#8-fixtures-for-tsverify-test)) |

The skeleton for step 3:

```yaml
# tsverify:example
behavior: Invoice lifecycle
entity:
  name: Invoice
  state: status
  states: [draft, open, paid, void]
  initial: draft
  terminal: [paid, void]
actors:
  system: { trust: internal }
transitions: {}
bindings:
  storage: assign
  clients:
    db: { module: src/db.ts, export: db }
```

It reports something like the following. The `spec-property` findings (stuck and unreachable states) go away once
you add transitions:

```text
✗ undeclared-transition  src/invoices/actions.ts:12:5
  finalizeInvoice writes draft → open, which no spec transition declares.
  hint: Declare this transition in the spec with impl: src/invoices/actions.ts#finalizeInvoice, or remove the write.
✗ undeclared-transition  src/invoices/actions.ts:36:3
  voidInvoice writes {draft, open} → void, which no spec transition declares.
```

### 5.2 Find writes with grep

| Persistence | Command (replace `status`) | What to look at |
|---|---|---|
| `assign`, `memory` | `grep -rnE '\.status\s*=[^=]' src` | assignments |
| `assign` | `grep -rnE 'status:\s*["A-Z]' src` | spreads passed to a save call: `save({ ...x, status: "paid" })` |
| `prisma` | `grep -rnE '\.(update\|updateMany\|updateManyAndReturn\|upsert)\(' src` | calls whose `data` (or `update` for `upsert`) sets `status` |
| own functions (`bindings.storage`) | `grep -rnE 'status\s*[:=]' src` | patches (`{ status: … }`, also held in a `const`), assignments, and query-builder writes (`.set({ status })`) |
| any | `grep -rnE 'status' src \| grep -v test` | anything the two above missed (raw SQL, helpers taking the status as a parameter) |

A write that grep finds but `tsverify check` doesn't list is in a shape `tsverify` doesn't understand. Either restructure
it ([§7.5](#75-restructuring-unanalyzable-code)) or note it in the PR as unchecked.

### 5.3 Worked example

Existing code (`src/invoices/actions.ts`). `db`, `email` and `payments` are imported from their own modules, and
the guards from `src/auth.ts`:

```ts
export async function finalizeInvoice(actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const invoice = await tx.invoices.get(id);
    requireOwner(actor, invoice);
    if (invoice.status !== "draft") throw new Error("not a draft");
    invoice.status = "open";
    await tx.invoices.save(invoice);
  });
}

export async function onInvoicePaid(event: { invoiceId: string }): Promise<void> {
  const paid = await db.transaction(async (tx) => {
    const invoice = await tx.invoices.get(event.invoiceId);
    if (invoice.status !== "open") return undefined;
    invoice.status = "paid";
    await tx.invoices.save(invoice);
    return invoice;
  });
  if (paid === undefined) return;
  await email.send({ to: paid.email, template: "receipt" });
}

export async function voidInvoice(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const invoice = await db.invoices.get(id);
  if (invoice.status === "paid" || invoice.status === "void") throw new Error("too late");
  await payments.cancelIntent(invoice.id);
  invoice.status = "void";
  await db.invoices.save(invoice);
}
```

Reading it with the steps above: the entity is `Invoice.status` (`draft | open | paid | void`). There are three
writes, one per exported function. The from-states are `draft`, `open`, and `draft | open` (what remains after
the `paid`/`void` check). The callers are a customer (owner check), the payment provider's webhook (it can
redeliver, so `idempotent`), and an admin (role check). The effects are the receipt email and the payment-intent
cancellation. Each should happen once, and every transition should be atomic. `voidInvoice` *should* be atomic
too, so the spec says so. The result is the spec in [§2](#2-anatomy-of-a-spec). `tsverify check` reports:

```text
✗ non-atomic  src/invoices/invoice.behavior.yaml:36:3 · src/invoices/actions.ts:33:25
  void: voidInvoice reads the entity (db.invoices.get) and writes void outside one atomic scope; the spec says atomic.
  ↳ consequence: ✗ implementation-property … Exactly-once effect `payments.cancel` fires 2 times for one Invoice.
  ↳ consequence: ✗ implementation-property … Rule "A paid invoice is never voided" … is violated
      step 2  void#1 read → proceed  status=open
      step 3  pay#1 atomic → proceed  status=paid  email.receipt=1
      step 4  void#1 write  status=void  ✗ rule:A paid invoice is never voided
```

That is a real bug: an admin can void an invoice that was paid a moment earlier. `tsverify test` replays that trace
against the real code and reports `replay-confirmed`. The fix belongs in the code, not the spec. Do the read,
check and write in one transaction, and cancel the intent after the commit:

```ts
export async function voidInvoice(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const voided = await db.transaction(async (tx) => {
    const invoice = await tx.invoices.get(id);
    if (invoice.status === "paid" || invoice.status === "void") throw new Error("too late");
    invoice.status = "void";
    await tx.invoices.save(invoice);
    return invoice;
  });
  await payments.cancelIntent(voided.id);
}
```

`tsverify check` and `tsverify test` then exit 0.

---

## 6. Reading findings

```text
Invoice lifecycle
  ✗ non-atomic  <spec file:line> · <code file:line>     ← category, where in the spec, where in the code
    void: voidInvoice reads … outside one atomic scope   ← message
    hint: Wrap the read and write in one transaction …   ← suggested fix
    ↳ consequence: ✗ implementation-property …           ← caused by the finding above it
      trace: step 0 … step 4 … ✗ <property>              ← counterexample, one step per action
```

`✗` is an error, `⚠` a warning, `ℹ` info. **Fix root causes first.** A `↳ consequence` goes away with its cause
(`causedBy` in JSON). A transition the code lacks (`missing-transition`, or one tsverify couldn't confirm) shows up
in the code's model as an entity that stops where the spec goes on, so a stuck state (`no-stuck-states`) or an
`eventually` rule that fails there is printed as its consequence. A trace step `t#2 read → proceed` means the second concurrent invocation of `t` read the state
and passed its check. `write` is its write, and `atomic` is a read and write in one step. `(duplicate delivery)` marks
a redelivered `idempotent` event.

### 6.1 Every finding category

| Category | Severity (exit) | Means | Do this |
|---|---|---|---|
| `invalid-spec` | error (2), or warning | The spec doesn't parse or validate: unknown key, unknown state or actor, rule syntax, unbound guard. Warnings: a terminal state with an outgoing transition, an unused guard binding | Fix the YAML at the location. Most messages carry a "did you mean" |
| `broken-link` | error (2) | `impl`, a client, a guard or a storage function binding doesn't resolve: missing file, file not in the tsconfig, missing export, not a function with a body, no `tsconfig.json`. Also a `bindings.storage` function that isn't exported (generated tests can't replace it) | Fix the path (project-root relative) or the symbol (`file.ts#name`, `file.ts#Class.method`); export the storage function |
| `spec-property` | error (1), or warning | The **spec** breaks a property, as a design bug. See [§6.2](#62-built-in-properties) | Fix the design (`atomic`, `from`, `idempotent`, a missing transition). Don't delete the rule |
| `implementation-property` | error (1) | The **code's** model breaks a property, with a trace. Usually a `↳ consequence` of a conformance finding | Fix the root cause. If it stands alone, the code reaches a bad state the spec forbids. Fix the code |
| `undeclared-transition` | error (1) | The code writes a state change that no transition declares, or a linked function writes a different `to` | A legit transition: declare it with that `impl`. A bug (B1 "reopen"): remove the write. Test or seed code: keep it out of the tsconfig `include` |
| `missing-transition` | error (1) | A transition has `impl`, but nothing reached from it writes `state = to`. When the impl reaches a state write `tsverify` can't read, it says "couldn't confirm" instead (an `unanalyzable` warning) | Wrong `impl`, a write `tsverify` doesn't see at all (a raw query), or the code really doesn't do it |
| `from-state-unconstrained` | error (1) | The code writes `to` from **any** state: nothing before the write consults the state. (A field typed `string` is reported once, as `unanalyzable`, instead; so is a state the code does consult in a form `tsverify` can't read: "the from-state check at … is in a form tsverify can't read", see below) | Add the check (`if (x.status !== "paid") throw`) in the same atomic scope, or put the state in the update's `where`. A passing `forbidden` test from `tsverify test` means a check exists that `tsverify` can't see: restructure it ([§7.5](#75-restructuring-unanalyzable-code)) |
| `from-state-mismatch` | error (1), or warning | Error: the code allows extra from-states. Warning: the code is stricter than the spec | Error: tighten the code's check. Warning: confirm which is intended. Narrow the spec only if the stricter code is the intent |
| `guard-not-dominating` | error (1) | A guard in the transition's `requires` is never called, or is skipped on some path (an early return, a flag) before the write: "`ship: role(admin) (requireRole) is called on some paths but not all before the write`". With several actors in `by`: some path passes none of the listed actors' guards in full: "`cancel: cancelOrder reaches the write on a path that passes only {verified}; it must pass owner to act as customer, or role(admin) to act as admin.`" (one finding per such path) | Call the guards on every path before the write: on each path, those of the actor the caller acts as. Don't remove them from the spec |
| `undeclared-effect` | error (1) | The code calls a bound client on the transition's path that the transition doesn't declare | An intended effect: declare it with the right multiplicity. Not intended (B5: a refund on expiry): remove the call |
| `missing-effect` | error (1), or warning | A declared effect is never called when the transition happens. A warning when the effect's client is bound but no call anywhere in the project resolves to it: then `tsverify` can't see the call, and says "couldn't confirm" (caused by the binding's own `unanalyzable` warning) | Call it, or fix `bindings.effects` / `bindings.clients` so `tsverify` can see the call ([§7.1](#71-all-persistences)) |
| `non-atomic` | error (1) | `atomic: true`, but the code's read and write are not in one atomic scope (no transaction, a read through the root client, a non-Serializable Prisma transaction). When `tsverify` can't tell (no read found, a write saved outside `bindings.storage`), it reports that as `unanalyzable` instead, and no `non-atomic` | Use a transaction / conditional update / no `await` between check and write ([§7](#7-code-shapes-tsverify-understands)). Never drop `atomic` to pass |
| `generated-test-failed` | error (1) | A test from `tsverify test` failed: a path test (allowed transition), forbidden test (disallowed from-state), or guard test (an actor outside `by`, or another actor in `by`). Also a replay that could not run. "… could not start, before any of the code under test ran" (`…:setup:<file>`) is a setup problem instead: a test file that couldn't load | Read the assertion. It's the real code misbehaving, or bad `fixtures` ([§8](#8-fixtures-for-tsverify-test)). A setup failure: make the modules the tests import resolve under vitest ([§8](#8-fixtures-for-tsverify-test)) |
| `replay-confirmed` | error (1) | The real code reproduced a counterexample: the bug is confirmed | Fix the code. The test in `.tsverify/generated/` fails until you do |
| `replay-disagrees` | warning (0) | The real code did not reproduce a counterexample (it threw, or took another path) | Check that the "Observed" line is a real rejection, not a setup error. If the code is right, the extracted model over-approximates. Mention it in the PR |
| `unanalyzable` | warning or info (0); with `--strict`, warnings are errors (1) | `tsverify` couldn't tell: from-state of a `string` field, a write of a non-literal value or in a shape it can't read (then each transition it would confirm says "couldn't confirm that … writes …", as a `↳ consequence`), a read it can't see, a write saved outside `bindings.storage`, a client or storage function that is bound but never called (the binding most likely points at the wrong export), a transition without `impl` (info), an unsupported persistence, the state limit (the hint names what makes the search large, and how to lower `concurrency`) | Restructure the code ([§7.5](#75-restructuring-unanalyzable-code)) or add `impl`. Unanalyzable code is unchecked code. Don't leave new ones unexplained |
| `not-generated` | info (0); with `--strict`, a transition with `impl` that got no test at all, or a spec that got none, is an error (1) | `tsverify test` generated no test for a transition or actor: no `fixtures`, no `impl`, `memory` persistence, an impl whose key and actor arguments tsverify can't trace ("can't tell which arguments of … carry the key": give them under `fixtures.args`), an actor without a fixture. With several actors in `by`: a caller acting as one of them but failing its guards (one fixture per actor can't express it; the static check covers it) | Add fixtures, or accept it (e.g. `memory` has no test support yet) |

### 6.2 Built-in properties

`spec-property` and `implementation-property` findings name a property (the `property` field, and the last trace step):

| Property | Fires when | Typical fix |
|---|---|---|
| `untrusted-guarded` | An `untrusted` actor performs a transition with no guard | Add `requires` (e.g. `owner`) |
| `webhook-idempotent` | A `signed-webhook` actor performs a non-`idempotent` transition | `idempotent: true`, and make redelivery safe |
| `effect-multiplicity` | An `exactly-once` effect can fire twice for one entity | `atomic: true` on the emitting transition, or narrower `from` so a repeat is rejected |
| `no-stuck-states` | A non-terminal state has no way out | Add the missing transition, or mark the state `terminal` |
| `reachable` (warning) | A declared state is never reached from `initial` | Add the transition into it, or remove the state |
| `rule:<name>` | A rule is violated (`always`/`never`: some reachable state; `eventually`: some end state) | Fix the design or the code, as the trace shows |

The checker explores one entity with `concurrency.default` (2) invocations per transition, so a counterexample is
always short. A non-atomic transition is two steps (`read`, then `write`), and the gap between them is where races
show.

### 6.3 Fix the code or the spec?

| Situation | Change |
|---|---|
| The code does something the business doesn't want | **Code** |
| The spec was wrong about the intent (a human confirmed it) | **Spec**, and say why in the PR. `tsverify diff` shows the change |
| The intent changed (a new feature) | **Spec first**, then code |
| `tsverify` can't read a correct code shape | **Code shape** ([§7.5](#75-restructuring-unanalyzable-code)), or explain the warning in the PR |
| A `tsverify` bug (exit 3, or a finding that is provably wrong) | Neither. Report it |

---

## 7. Code shapes tsverify understands

`tsverify` reads source code with the TypeScript type checker. It never runs your code and never connects to a
database. It is conservative: when unsure, it reports `unanalyzable` or "unconstrained" rather than guessing.

### 7.1 All persistences

| Concern | Understood | Not understood → what to do |
|---|---|---|
| **Entity type** | A type named `entity.name`, also behind `Readonly<T>`, `Pick<T, …>`, `Omit<T, …>`, `Partial<T>`, unions and type parameters. Fallback: any type whose state field's union equals `states` exactly, read through a bound client | A differently named type with a different union → not matched. Use the type's name |
| **State type** | String-literal union (`"a" \| "b"`), string `enum`, Prisma enums (generated const object + union) | `string` / `any` → from-state unknown. Type the field as a union |
| **`impl`** | `file.ts#fn` (function declaration, `const fn = async () => …`, `const fn = withAuth(async (ctx) => …)`), `file.ts#Class.method`, `file.ts#obj.method` | Functions built at runtime, or picked from a map → export a named function |
| **Call graph** | Helpers in project files, followed up to 8 levels below the impl | Calls through `node_modules`, dynamic dispatch, callbacks stored and called later |
| **From-state checks** (narrowing) | `if (x.status !== "a") throw`, early `return`, `switch (x.status)`, `x.status === "a" \|\| x.status === "b"`, assertion functions (`asserts x is Paid`), type predicates (`x is Paid`, incl. inferred `return s === "a"`), ternaries, checks inside the transaction callback; membership on a list of literals, inline or a `const` (`if (!["a", "b"].includes(x.status)) throw`, `ALLOWED.includes(x.status)` with `const ALLOWED = ["a", "b"]`, `OPEN.has(x.status)` with `const OPEN = new Set([…])`), combined with `!`, `&&`, `\|\|` | A lookup table (`NEXT[x.status].includes(to)`), a list that can change (a `let`), `const s = x.status; if (s …)`, `const { status } = x`, `const ok = x.status === "a"; if (!ok)` on a mutable field, `: boolean` helpers, the entity passed to a helper that throws → compare `x.status` directly, or use an assertion function. When the code consults the state in such a form, the write's from-state is reported unknown (`unanalyzable`, "the from-state check at … is in a form tsverify can't read"), not unchecked |
| **Written value** | A string literal, or a constant with a literal type (`JobStatus.Done`) | A variable or parameter (`x.status = next`) → `unanalyzable`, and the write is not checked: a transition whose impl reaches it is reported as "couldn't confirm", not `missing-transition`. Write the literal at each call site |
| **Guards** | A call to the bound function, with literal arguments equal to the binding's (`requireRole(actor, "admin")` = `role(admin)`), on every path before the write. Arguments that aren't literals (`actor`, `{ orUserId }`) are skipped, so `requireRole(tx, ctx, ["owner", "admin"], { orUserId })` matches the binding `requireRole(["owner", "admin"])`; a list matches an array literal (or a `const` holding one) with the same items, whatever the quotes. A call with other literal arguments is reported as "called, but not with …". A project function that calls the guard on every path counts as that guard | Middleware registered elsewhere (route-level `app.use(auth)`), decorators → call the guard (or a wrapper) inside the impl's reach. Arguments built at runtime (`requireRole(actor, roles)` with a parameter) → pass the literals, or bind a wrapper (`requireAdmin`) |
| **Clients** (database, effects) | Calls on an exported object or function, imported directly (also aliased, re-exported or through a namespace import): `stripe.refunds.create(…)`, or `sendMail(…)` for `export async function sendMail` (map its effect to the client name, [§8](#8-fixtures-for-tsverify-test)); the transaction alias `tx`; a client injected as a parameter or field typed as the export (`constructor(private prisma: PrismaClient)`, `deps: { db: typeof db }`); and, for a client bound to an exported **class**, any instance of it held that way (see "Injected clients" below) | Destructured (`const { orders } = db`), element access (`db["orders"]`), a call's result as the root, an injected client typed `any`, as an interface, or with a type several clients share → import the bound export, or type the parameter as the export's type. A bound client that no call resolves to gets an `unanalyzable` warning ("bound but never called") |
| **Effects** | A bound-client call that can run on a path that performs the write and completes normally (before the write, or after the commit) | A call only on a path that throws or returns before the write is not attributed. That is correct |

**Injected clients.** Code that receives its clients (a constructor, a resources object such as `this.$`) is
matched by the declared type of what holds them. Bind the export that type names: for `this.$.runQueue` with
`runQueue: RunQueue`, bind the class, `queue: { module: src/run-queue/index.ts, export: RunQueue }`; every
instance typed `RunQueue` (a field, a parameter, a property of an injected object) is then the `queue` client,
and `this.$.runQueue.acknowledgeMessage(…)` is the call `queue.acknowledgeMessage`. Types compare by identity:
an instance held as an interface the class implements, as a subclass or as `any` is not matched. When nothing
matches, `check` says so: the binding gets a "bound but never called" warning, and each effect on it a
`missing-effect` **warning** ("couldn't confirm … no call in the project resolves to client queue") instead of
an error, with the effect taken as specified meanwhile. The same goes for `bindings.storage`: a function bound
by a path no call resolves to (`DelegatingStore.save` when the code calls `store.save` on a `Store` interface)
gets the warning; bind the one the code calls (`types.ts#Store.save`).

**Effect identity is the call.** An effect is recognized by its call path, `bindings.effects` maps names to
paths, and a call is one path. So two effect names bound to the same call (`queue.ack_cancel` and
`queue.ack_expire`, both `queue.acknowledgeMessage`) can't be told apart in the code: a transition that declares
one of them gets that one, and any other call of that path is named after the first of them alphabetically, so
a transition that acknowledges for another reason is reported as `undeclared-effect` `queue.ack_cancel`, and a
rule about `count(effect queue.ack_cancel)` may count it. To cope, either:

- use one effect name per call path (`queue.ack: queue.acknowledgeMessage`), declare it on every transition that
  acknowledges, and let the rule say *which* by the state (`never: status == EXPIRED and count(effect notify.cancel) > 0`,
  with the cancel-only effect), or
- give each meaning its own call: a small exported function per reason (`ackCancelled(…)`, `ackExpired(…)`, each
  calling `acknowledgeMessage`), bound as its own client (`ack_cancel: { module: …, export: ackCancelled }`).

**Several transitions, one `impl`.** A write reached from an `impl` belongs to that transition; when several
transitions' impls reach it, the ones whose `to` is the written state win. Transitions that share an `impl`
*and* a `to` are each compared with every write of that state the impl reaches: each gets all of them. Their
from-states are checked together (a `from-state-mismatch` warning only for a state none of the writes accepts),
but the transitions themselves can't be told apart, so a write meant for one is checked against the other's
`from`, `requires` and `effects` too: `regress` (mitigated → open) and `reopen` (resolved → open) with one impl
each get a `from-state-mismatch` error for the other's state, which says that they share the impl and `to`.
Declare them as one transition with the union of their `from` (comment which code path covers which state), or
point each at the function that only does its part. Don't widen each one's `from` to the union.

### 7.2 `assign`: repository objects (the default)

```ts
await db.transaction(async (tx) => {           // atomic scope: <client>.transaction(callback)
  const order = await tx.orders.get(orderId);  // read: a client call that initializes the reference
  if (order.status !== "paid") throw …;        // check
  order.status = "refunded";                   // write (or: tx.orders.save({ ...order, status: "refunded" }))
  await tx.orders.save(order);                 // commit: the next client call taking the reference
});
await stripe.refunds.create({ charge });       // effect, after the commit
```

| | Rule |
|---|---|
| Detected | When no Prisma or Drizzle import is found. Set `persistence: assign` to be explicit |
| Read | A call on a bound client (or on `tx`) whose result initializes the entity reference, also through a helper (`const o = await loadOrder(tx, id)`) |
| Write | `ref.<state> = "literal"`, or `{ ...ref, <state>: "literal" }` passed to a call, directly or as a `const` only that call takes (`const next = { ...order, status: "refunded" }; await tx.orders.save(next)`); anything else done with such a `const` (a `let`, two saves, the state set on it afterwards) is reported as `unanalyzable`, and so is the state set on a copy or an empty patch built in the function (`const next = { ...order }; next.status = "refunded"`, `const patch: Partial<Order> = {}; patch.status = …`) |
| Atomic | Read, write and commit inside one `<client>.transaction(async (tx) => …)` callback, all through `tx`. The method must be called `transaction`, with the callback as its first argument. A `db.…` call inside the callback bypasses the transaction |
| Not a write | `this.status = …` in a constructor, and new object literals (`{ id, status: "draft" }`) |
| `tsverify test` | Supported (in-memory fake store) |

### 7.3 `prisma`

```ts
const { count } = await prisma.order.updateMany({          // conditional update = atomic,
  where: { id: orderId, status: "paid" },                   // from-state = the where set
  data: { status: "refunded" },
});
if (count === 0) throw new ConcurrentUpdateError();
await stripe.refunds.create({ charge: order.chargeId });
```

| Shape | From-state | Atomic |
|---|---|---|
| `update`/`updateMany`/`updateManyAndReturn` with the state in `where` (`status: "paid"`, `{ in: […] }`, `{ not: … }`, `{ notIn: … }`, enum members) | The `where` set | yes |
| The same, with a condition `tsverify` can't read (inside `AND`/`OR`/`NOT`) | `*` | yes |
| Read (`findUnique…`, `findFirst…`), check, then `update({ where: { id } })` | Narrowed type at the write | **no** |
| The same inside `prisma.$transaction(async (tx) => …, { isolationLevel: "Serializable" })`, all through `tx` | Narrowed | yes |
| The same inside `$transaction` at the default level, `RepeatableRead` or lower, or the array form `$transaction([…])` | Narrowed | **no** (the message names the reason) |
| Blind update: no state in `where`, and no read | every state (`from-state-unconstrained`) | yes (the bug is the missing check) |

The update object may be held in a `const` first (`const data = { status: "refunded" }; await
prisma.order.update({ where: { id }, data })`), and so may the update's whole argument (`const args = { where:
{ id }, data: { status: "refunded" } }; await prisma.order.update(args)`): one used only by that update is read
as if written into the call. A `let`, one object for several updates, the state set on it afterwards
(`data.status = …`, also on an empty `const data: Prisma.OrderUpdateInput = {}`), `args.data` replaced, or any
other use is reported as `unanalyzable`, and the transitions reaching it as "couldn't confirm".

The entity is matched by model delegate, ignoring case: `prisma.order` is `entity.name: Order`. Bind the client
in `bindings.clients` (persistence is auto-detected from a `@prisma/client` or `PrismaClient` import). **Not modelled:** nested writes
(`data: { order: { update: … } }`), `upsert`'s `create` branch, raw SQL (`$queryRaw … FOR UPDATE`), `$extends`
and middleware, a client-wide default isolation level, and a read through a helper when the update's `where`
doesn't use `X.id`. No database or `prisma generate` is needed. `tsverify test` is supported (in-memory Prisma fake).
Example: [`examples/orders-prisma`](../examples/orders-prisma/src/orders/order.behavior.yaml).

### 7.4 `memory`: in-process objects

```ts
markWaiting(workerId: string): void {
  const w = this.workers.get(workerId);   // entity key: the get()/[key] argument
  if (w?.status !== "running") throw …;   // check (re-check)
  w.status = "waiting";                    // write: atomic, because no await since the check
}
```

| | Rule |
|---|---|
| Detected | Never. Set `persistence: memory`. No `clients` are needed for state |
| Write | `ref.<state> = "literal"`, including `this.status = …` outside constructors |
| Atomic | No `await`, `yield`, `for await` step or deferred callback (`.then(cb)`, `setTimeout(cb)`) on any path between the last re-check of the state field (or the impl's entry) and the write, across helpers |
| Not understood | Re-entrancy without `await` (a synchronous callback that re-enters). Implicit state machines (`holder: string \| undefined`) can't be specified: add an explicit literal-union state field |
| `tsverify test` | Not supported yet (`not-generated`). `tsverify check` works |

Example: [`packages/runtime/src/scheduler.behavior.yaml`](../packages/runtime/src/scheduler.behavior.yaml).

There is no Drizzle preset. A project that imports `drizzle-orm` and has no `bindings.storage` gets one
`unanalyzable` warning and no code model. Describe its storage with the app's own functions instead
([§7.6](#76-storage-point-at-your-own-functions)), which works whatever the database: Drizzle, SQL, an HTTP API.

### 7.5 Restructuring unanalyzable code

Prefer a small, behavior-preserving refactor that makes the code checkable over leaving it unchecked.

| Warning or symptom | Restructure to |
|---|---|
| "assigned a value that is not a single literal" (`setStatus(order, next)`), and "couldn't confirm that … writes …" on the transitions it serves | One function per transition, each writing a literal (`order.status = "paid"`). A generic verb that takes the target state (`setStatus(id, input.status)`) can stay as the entry point if it calls one of those per target state, or a conditional save with literal states (`setStatusIf(id, "open", "mitigated")`, bound as `update`) |
| "is set in `patch` …" / "is set on `patch` … after the object is built" | Build the patch as one `const` object literal with the state as a literal (`const patch = { status: "resolved", resolvedAt: now }`) and pass it to one bound save. Setting other fields on it afterwards is fine; setting the state field is not |
| "written in a patch passed to `tx.update(…).set`, which is not a `bindings.storage.save` function" | Move the query into a named function (`setIncidentStatusIf(tx, id, from, to)`) and bind it in `bindings.storage` (`update` for a conditional save, `save` otherwise) |
| "Nothing reads one … before this update" (a bulk `update(…).set({ status })` over the rows a query matches) | Move it into a named function, bound as an `update` with the states its query requires as `from` (`resolveOpenIncidents(tx, monitorIds)` with `from: [open, investigating]`, `to: resolved`) |
| "the from-state of this write is unknown: … is typed string" | `status: OrderStatus` with `type OrderStatus = "draft" \| …` |
| "the from-state check at … is in a form tsverify can't read" (a lookup table `NEXT[x.status].includes(to)`, the entity passed to a helper that throws, `assertTransition(x, to)`, a copy `const { status } = x`, a list that can change) | Compare the field directly in an `if`/`switch` (or `.includes` / `Set.has` on a `const` list of literals), or declare the helper as an assertion function (`function assertPaid(x: Order): asserts x is Order & { status: "paid" }`). tsverify doesn't follow a helper's body. Until then the write's from-state is unknown (a warning), not unchecked |
| `from-state-unconstrained`, although a check exists | The check compares the field with a literal but doesn't stop the write on the other branch (no `throw` or `return`), or it checks another variable. Make it exit |
| "no read of `x` through a bound client was found" | Read the entity through the bound client (or `tx`) in the impl or a helper it calls. Don't pass the entity in from outside |
| `missing-effect`, although the call exists | Call it on an imported module-level object that is bound in `bindings.clients`. Map the effect to that call path in `bindings.effects` |
| `guard-not-dominating`, although a middleware checks it | Call the guard (or a wrapper that calls it) inside the impl, before the write |
| `undeclared-transition` from test or seed files | Exclude them from the `tsconfig.json` that the spec's project uses (`"include": ["src"]`), or point `tsverify check --project` at a tsconfig that excludes them (`--project tsconfig.src.json`) |
| Clients injected with a type `tsverify` can't tie to one export (`any`, an interface several clients share) | Type the field or parameter as the export's type (`typeof db`, or the class for a class-bound client), or export the client from a module and import it where it is used. For DI frameworks, a thin exported function per transition that the class delegates to |
| "client … is bound but never called", or "storage … function … is bound but never called" | Point the binding at what the code calls: the class its instances are typed as, the interface method a `store: Store` call resolves to. Remove bindings the code doesn't use |

### 7.6 Storage: point at your own functions

Most apps already have a storage layer: a repository, a data-access module, a service. Instead of a preset,
name its functions under `bindings.storage` ([format](behavior-format.md#bindingsstorage)). tsverify then treats
them as the storage boundary and never looks inside, whatever they use underneath.

```yaml
bindings:
  storage:
    read:   src/orders/repo.ts#getOrder          # getOrder(id) → Order | undefined
    save:   src/orders/repo.ts#saveOrder         # saveOrder(order)
    update: src/orders/repo.ts#setStatusIf       # setStatusIf(id, from, to) → boolean
    atomic: src/db.ts#withTransaction            # withTransaction(async () => { … })
```

How to find them:

| Kind | Look for | Grep |
|---|---|---|
| `read` | the function the transition's `impl` calls to load the entity by key, before checking its state | `grep -rnE "export (async )?function (get\|find\|load)" src/` |
| `save` | the function the `impl` passes the changed entity (or the key and the changed fields) to | `grep -rnE "export (async )?function (save\|update\|upsert\|put)" src/` |
| `update` | a function that writes the state **only if** it still has the expected value, in one statement or command: `UPDATE … WHERE id = ? AND status = ?`, `updateMany({ where: { id, status } })`, a DynamoDB `ConditionExpression`, a Redis script | `grep -rnE "WHERE .*status\|ConditionExpression\|updateMany" src/` |
| `atomic` | a function that takes a callback and runs it in a transaction or under a lock | `grep -rnE "transaction\|withLock\|mutex" src/` |

- **Roles.** When the arguments aren't in the default order (`read(key)`, `save(entity)`,
  `update(key, from, to)`, `atomic(callback)`), give them with `args`, e.g.
  `{ fn: src/repo.ts#findOrder, args: [_, key] }` for `findOrder(tenantId, id)`. A save that takes the key and
  some fields is `args: [key, patch]`. An update with the states built in (`markPaid(id)`) is
  `{ fn: …, from: [pending], to: paid }`. Each role is one positional argument: a function that takes one object
  of named arguments (`getIncident({ tx, id, workspaceId })`) isn't supported yet, and binding its object as the
  `key` gets a warning ("argument 1 … is an object"). Bind a thin wrapper that takes the key as an argument of its
  own (`getIncidentById(tx, workspaceId, id)` with `args: [_, _, key]`).
- **`returns`.** Say what an update returns when the state check fails: `changed` (`false`, the default),
  `count` (`0`), `entity` (`undefined`) or `throws`. The code is expected to stop when it does
  (`if (!(await setStatusIf(…))) throw …`, `if (updated === undefined) return`): an effect that can run before
  that check (or before the update) fires even when nothing was saved, and `check` reports the transition as
  `non-atomic`. An effect only in the "nothing saved" branch is not the transition's. A `count` may also be a
  count object (`r.count === 0`), as Prisma's `updateMany` returns.
- **An unconditional ("blind") update** writes its state whatever the stored one is (`update({ where: { id } })`
  with a fixed status, a store method such as `startAttempt(id, …)` that sets `EXECUTING` unconditionally). Bind
  it with `from` **every state** (a YAML anchor helps: `from: &ALL [DELAYED, PENDING, …]`, then `from: *ALL`) and
  `returns: throws`: it never "finds the state changed", so there is no result to check (it can only throw, e.g.
  for a missing row), and no effect counts as running "although it saved nothing". `check` then reports the
  missing state check honestly, as `from-state-unconstrained` on each transition whose spec `from` is narrower.
  Don't give it the spec's `from`: tsverify trusts a bound `from`, so that would hide the missing check.
- **Pass every argument a role names.** The generated tests' fake reads each role's argument. The one exception
  is a `patch`: leaving it out (`updateStatusIf(id, "paid", "refunded")`) counts as `{}`, so nothing is merged.
- **`atomic` is declared, not proven.** Name a function only if it really serializes the callback against
  other requests (a database transaction at a sufficient isolation level, or a lock). tsverify trusts the
  declaration and can't check what happens inside; the generated replay tests still run the race through it.
- **Exported, in their own module.** Generated tests replace the functions by mocking the module that exports
  them, so each must be exported (a function that isn't is a `broken-link` error; `check` still reads its calls),
  and a call from inside that same module (an `impl` next to `getOrder` in `repo.ts`) still reaches the real one.
  Keep the `impl`s in other files. Guards need not be exported: tests run them as they are.
- **Only the functions the transitions call.** One read, one save and the conditional saves and atomic
  wrappers that the `impl`s use are enough; list several of a kind if the code uses several.
- **Calls are matched by symbol**, through imports, renamed re-exports, namespace imports and helpers, never by
  name.
- **Writes it reads:** `order.status = "refunded"` followed by a bound save of `order`; a patch with the state passed
  to a bound save (`patchOrder(id, { status: "refunded" })`), also when it is a `const` object literal used only
  there (`const patch = { status: "refunded", refundedAt: now }; await patchOrder(id, patch)`); and a conditional
  save (`setStatusIf(id, "paid", "refunded")`).
- **Writes it reports as `unanalyzable`** (`--strict` makes them errors), so it never misses one silently:
  - a state value that is not a literal (`{ status: input.status }`); every transition whose `impl` reaches it is
    then "couldn't confirm that … writes …" instead of `missing-transition`;
  - a patch object built up before the call: a `let`, one passed to several calls, or the state set on it
    afterwards (`patch.status = …`);
  - a write saved through a function the binding doesn't name (an older data layer, a raw query helper, an inline
    query builder such as Drizzle's `tx.update(incident).set(patch)`). Its atomicity is then unknown, so `check`
    gives no `non-atomic` verdict on it either. Name that function in `bindings.storage`, or move the query into one.
- **Whose patch it is.** A patch passed to a bound save is the entity's. One passed to another function is the
  entity's when its type, or the parameter's, names the entity (`Partial<Order>`), or when its state field allows
  exactly the spec's states (ignoring `undefined` and non-literal members, as in Drizzle's column types) and
  either a bound `read` of the entity comes before it in the same function, or the call is an update: a method
  named `update`, `updateMany`, `updateOne`, `updateTable` or `upsert`, or `set` called on what one returned.
  That last rule catches bulk updates with no read of one entity before them: Drizzle's
  `tx.update(incidents).set({ status: "resolved" }).where(…)` takes a patch typed from the table, whose `status`
  column has exactly the spec's states. Such a write is reported (its from-state is unknown: it changes
  whichever rows its query matches), never skipped. Other objects with a `status` key are not writes: a response
  body (`c.json({ status: "ok" })`), or an event passed to a function that isn't an update
  (`bus.publish({ id, status: "resolved" })`), even when its type has exactly the spec's states. An ORM update's
  `data` (`prisma.order.update({ where, data: { status } })`) is such a patch too.
- **Use a preset instead** (`storage: assign`, `prisma` or `memory`) when there is no such layer: the `impl`s
  call a Prisma client directly (`prisma`), a repository object on a bound client (`assign`), or in-process
  objects (`memory`, see [§7.2–7.4](#72-assign-repository-objects-the-default)). If the code reads and writes
  inline, with no function to point at, extract one ([§7.5](#75-restructuring-unanalyzable-code)).

What `tsverify check` says, for a refund that reads and saves outside `withTransaction`, and for the clean code
(the transitions that rely on `withTransaction` are named, because tsverify trusts it and can't look inside):

```
✗ non-atomic  src/orders/order.behavior.yaml:52:3 · src/orders/refund.ts:10:23
  refund: refundOrder reads the entity (storage.getOrder) and writes refunded outside one atomic scope; the spec says atomic.
  hint: Run the read and the save inside one `bindings.storage.atomic` function, or save with a conditional save (`bindings.storage.update`) and stop when it saved nothing.

checkout, refund, ship: atomic, as declared by `withTransaction` (not checked inside it)
✓ no findings
```

Example: [`examples/orders-functions`](../examples/orders-functions/src/orders/order.behavior.yaml).

---

## 8. Fixtures for `tsverify test`

`tsverify test` generates vitest tests into `<project>/.tsverify/generated/` (add `.tsverify/` to `.gitignore`) and runs them
with the project's own vitest (`npm i -D vitest`; versions 3.0.5 and later). It replaces each `bindings.clients` export with an in-memory fake (a store for
`assign`/`prisma` clients, call recorders for effect clients), seeds one entity, and calls each `impl`:

| Test file | One test per | Passes when |
|---|---|---|
| `paths.test.ts` | transition × allowed `from` state | The stored state becomes `to`, each `exactly-once` effect is called once, and no other effect is called |
| `forbidden.test.ts` | transition × state outside `from` | The state is unchanged and no declared effect fired (throwing is fine) |
| `guards.test.ts` | transition × actor with a fixture that is not in `by`; and, for a `by` with several actors, each listed actor with a fixture other than the one the path tests use | Not in `by`: the state is unchanged and no declared effect fired. In `by`: like a path test, acting as that actor alone |
| `replay-<n>.test.ts` | finding with a counterexample | The real code, forced through the same interleaving, does not violate the property |

```yaml
fixtures:
  entity: { id: o1, ownerId: c1, email: c1@example.com, chargeId: ch_1 } # every field the code reads, except the state field
  actors:
    customer: { id: c1, roles: [] } # the value passed where the impl takes an actor
    admin: { id: a1, roles: [admin] }
  args:
    payment_succeeded: [{ id: evt_1, orderId: $id, chargeId: ch_1 }] # only when the defaults don't fit
```

- `entity` must include the storage key (`id`), and every field the code dereferences.
- Give a fixture to every actor whose impl takes an actor (usually people), including ones that should be
  rejected: they drive the guard tests. Webhook and job actors usually take no actor argument and need none.
- One entity fixture serves every state. If an effect depends on a field (a refund only when `depositId` is
  set), set the field so that the effect happens: path tests expect each `exactly-once` effect exactly once.
- `args` are used for every actor's test of that transition, including the guard tests.
- Without `args`, `tsverify` builds the arguments from the impl's parameters: it traces the key the code reads
  the entity with, and the actor its guards get, back to the impl's parameters, and puts the entity id and the
  actor there (`(ctx: { actor }, orderId)`). Use `args` when the impl needs more (an event payload, a
  `{ ctx, input }` object with other fields), or when the trace fails ("can't tell which arguments of … carry the
  key": a key read from a parsed input, or through a helper). With `args`, nothing is traced. Inside `args`,
  `$id` is the seeded entity's key and `$actor` is the acting actor's fixture, e.g.
  `approve: [{ ctx: { workspace: { id: 1 }, actor: $actor }, input: { id: $id } }]`.
- Only the bound export of a client module is replaced; its other exports (a guard or helper next to `db`) stay
  real. A client may be a bare exported function (`email: { module: src/mail.ts, export: sendMail }`): map its
  effect to the client name (`bindings.effects: { email.welcome: email }`) and the fake is a recording function.
- Fixtures hold one value per actor, which should pass that actor's guards. So for a `by` with several actors,
  "acting as one of them but failing its guards" can't be generated (a `not-generated` info); actors outside `by`
  are the rejected callers.
- `memory` persistence generates no tests yet.
- An `impl` that is an instance method (`file.ts#Class.method`, not `static`) gets no test yet (`not-generated`,
  an error under `--strict`): a test would need an object of the class to call it on.
- A binding the generated mocks can't replace means no test for the spec (`not-generated`, with each reason): a
  client bound to a class (an object in its place would break `new`), or a storage function that is a method of
  an interface (a type: there is no value to replace) or of a class.
- The tests resolve imports like the project: the tsconfig's `customConditions` are passed to vitest, so a
  workspace package resolved to its sources (`"exports": { "@org/source": "./src/index.ts", … }`) resolves the
  same way. A test file that can't load at all (an import that doesn't resolve, a mock that can't be built) is
  reported once per error as a setup failure ("could not start, before any of the code under test ran"), not as
  a behavior the spec forbids.

---

## 9. Editor support: JSON Schema

The JSON Schema of the format gives completion, hover docs and inline errors in any editor that runs
`yaml-language-server` (VS Code with the Red Hat YAML extension, Neovim, JetBrains, Zed). Get the schema with
`tsverify schema > behavior.schema.json`, or use the copy that ships with the CLI:
`node_modules/@tsverify/cli/behavior.schema.json` (also resolvable as `@tsverify/cli/behavior.schema.json`). In
this repository it is checked in as [`packages/spec/behavior.schema.json`](../packages/spec/behavior.schema.json).

**Per file:** a modeline comment. The path is relative to the YAML file, or a URL. `tsverify` ignores comments:

```yaml
# tsverify:example
# yaml-language-server: $schema=../../node_modules/@tsverify/cli/behavior.schema.json
behavior: Light
entity:
  name: Light
  state: state
  states: [off, on]
  initial: off
actors:
  user: { trust: internal }
transitions:
  turn_on: { from: off, to: on, by: user }
  turn_off: { from: on, to: off, by: user }
```

**Per workspace (VS Code):** in `.vscode/settings.json`. The path is relative to the workspace root:

```json
{
  "yaml.schemas": {
    "./node_modules/@tsverify/cli/behavior.schema.json": "**/*.behavior.yaml"
  }
}
```

The schema checks structure only. Cross-references (unknown states, actors, unbound guards) and rule syntax are
checked by `tsverify validate`.

---

## 10. `enforced` and CI

- `enforced: true` at the top level marks a spec the team wants CI to **block** on. `tsverify` itself doesn't act on
  it: exit codes are identical. It shows up in `--format json` / SARIF, and `--enforced-only` (on `check`, `test`
  and `diff`) keeps only enforced specs, plus invalid ones.
- Adopting `tsverify` on existing code: start **advisory** (`tsverify check || [ $? -eq 1 ]`), fix or triage the findings,
  then mark the clean specs `enforced: true` and block on `tsverify check --strict --enforced-only`. `--strict` makes
  `unanalyzable` warnings errors, so code `tsverify` can't read doesn't pass silently.
- Turning `enforced` off shows in `tsverify diff`, because a spec counts as enforced when either side has it.
- Setups, SARIF upload and the sticky PR comment: [workflows.md](workflows.md), and the example workflow
  [`examples/ci/github/tsverify.yml`](../examples/ci/github/tsverify.yml).

```yaml
# tsverify:example
behavior: Door
enforced: true
entity:
  name: Door
  state: state
  states: [closed, open]
  initial: closed
actors:
  resident: { trust: authenticated }
transitions:
  open: { from: closed, to: open, by: resident, atomic: true }
  close: { from: open, to: closed, by: resident, atomic: true }
```

---

## 11. Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Weakening the spec to pass (dropping `atomic`, widening `from`, deleting a guard or rule) | Green check, bug shipped. `tsverify diff` shows it to reviewers | Keep the spec strict and fix the code |
| Paths relative to the spec file | `broken-link` | Paths are relative to the project root (the `tsconfig.json` directory) |
| `entity.state` is not the exact property name | `missing-transition` everywhere, or no writes found | Use the property name exactly (`status`) |
| `entity.name` is not the type name (assign, memory) or Prisma model | Writes not matched, unless the union equals `states` exactly | Use the type or model name |
| `states` is missing a member of the union that the code writes | `undeclared-transition`: "… ('x' is not a state of Order)", often with a stuck-state consequence | List every member of the union the code can write, then add the transitions into it |
| Deny-list checks (`if (s === "paid" \|\| s === "void") throw`) | `from-state-mismatch` once a new state is added | Check what is allowed (`if (s !== "draft" && s !== "open") throw`) |
| A non-terminal state with no exit (e.g. `archived`) | `no-stuck-states` | Mark it `terminal`, or add the transition |
| Putting a guard every caller needs only in some actors' `requires` | `by: [a, b]` accepts a path that passes either actor's guards, so the shared guard can be skipped | Put guards that apply to every caller in the transition's `requires` |
| `exactly-once` on a notification sent by several transitions under one name | `effect-multiplicity` | Name effects by meaning (`email.paid`, `email.shipped`), or use `at-least-once` |
| A webhook transition without `idempotent: true` | `webhook-idempotent` | Set it, and make redelivery safe (a from-state check) |
| Leaving `unanalyzable` warnings unexplained | The code is unchecked, and CI stays green | Restructure ([§7.5](#75-restructuring-unanalyzable-code)) or explain each one in the PR |
| Writing the state when creating an entity (`order.status = "draft"` on a new object) | `undeclared-transition` | Create entities with an object literal or ORM `create` |
| Test files in the analyzed tsconfig | `undeclared-transition` from tests | `"include": ["src"]` in the project's tsconfig |
| A project on TypeScript 5 or 6 | `check` and `test` exit 2: "tsverify needs TypeScript 7 or later to read your code. This project has TypeScript 5.9.3: upgrade it with `npm i -D typescript@latest`." | `npm i -D typescript@latest`. tsverify reads code with the project's own TypeScript, through TypeScript 7's API, which earlier versions do not have. `--spec-only` needs no TypeScript |
| Installing tsverify into a TypeScript 5 or 6 project with npm | `npm i -D @tsverify/cli` fails with `ERESOLVE`: "Could not resolve dependency: peerOptional typescript@">=7.0.0" from @tsverify/cli" | Upgrade TypeScript first (`npm i -D typescript@latest`), then install tsverify |
| A tsconfig that TypeScript 7 rejects (`baseUrl`, `moduleResolution: node10`, other options TypeScript 6 only deprecated) | `check` and `test` exit 2: "TypeScript 7.0.2 rejects …/tsconfig.json: Option 'baseUrl' has been removed. …" | Fix the tsconfig until `tsc --noEmit` accepts it (e.g. replace `baseUrl` with relative `paths`, use `moduleResolution: bundler` or `nodenext`) |

---

## 12. Checklist before you open the PR

- [ ] The spec sits next to the entity's type, inside the right TypeScript project.
- [ ] `states` lists every member of the state type. `initial` and `terminal` are right.
- [ ] Every write of the state field is a transition with an `impl`, or has been removed.
- [ ] Every transition that checks the state is `atomic: true`. Every webhook or queue transition is `idempotent: true`.
- [ ] Every `untrusted` actor's transitions have a guard. Every guard is bound.
- [ ] Every external call on a transition's path is a declared effect, with the right multiplicity.
- [ ] The rules state the invariants a reviewer would say out loud.
- [ ] `tsverify validate` and `tsverify check --strict` exit 0, or every remaining finding is listed in the PR with a reason.
- [ ] No spec change was made only to silence a finding. Every spec change is explained in the PR (see `tsverify diff`).
- [ ] `fixtures` are present, and `tsverify test` exits 0 (or its `not-generated` items are understood).
- [ ] New `unanalyzable` warnings are fixed or explained.
