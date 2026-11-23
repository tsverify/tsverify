# Behavior file format (v1)

`*.behavior.yaml` files describe intended behavior. `@tsverify/spec` (zod schema in `packages/spec/src/schema.ts`) is the
executable source of truth; this page is its human reference. Canonical example:
[`packages/spec/test/fixtures/valid/order.behavior.yaml`](../packages/spec/test/fixtures/valid/order.behavior.yaml).

## Paths

`impl`, `bindings.clients.*.module`, `bindings.guards` and `bindings.storage` paths are relative to the **project root**: the nearest
directory at or above the behavior file that contains a `tsconfig.json` (overridable with `tsverify check --project`).

A path may leave the project root (`../order-store/src/types.ts#OrderStore.findOrder`, for a storage interface in
another package of a monorepo). It resolves like any other, as long as the file is part of the project's
TypeScript program as source: the project imports it, and the import resolves to its `.ts` file (tsconfig `paths`,
`customConditions`, or a workspace package whose `exports` point at its sources), not to a `.d.ts` or a file
under `node_modules`. Otherwise it is a `broken-link` ("… is not part of the TypeScript project").

## Top level

| Key | Required | Type | IR (`@tsverify/ir` `BehaviorModel`) |
|---|---|---|---|
| `behavior` | yes | string | `name` |
| `summary` | no | string | `summary` |
| `enforced` | no | boolean (default `false`) | `enforced` (present only when `true`) |
| `kind` | no | `entity` (only value in v1; default) | `kind` |
| `entity` | yes | object | `entity` |
| `actors` | yes | map name → actor | `actors` |
| `transitions` | yes | map name → transition | `transitions` (sorted by name) |
| `rules` | no | list | `rules` (default `[]`) |
| `concurrency` | no | object | `concurrency` (resolved per transition) |
| `bindings` | no | object | `bindings` (defaults: empty maps) |
| `fixtures` | no | object | `fixtures` (absent when omitted) |

Unknown keys are an error (`invalid-spec`), so typos never silently pass.

### `enforced`

`enforced: true` marks a spec as one the team wants CI to block on. `tsverify` never acts on it by itself: exit codes
are the same with or without it. It is reported as `specs[].enforced` in `--format json`, as
`properties.enforced` on SARIF results, and `--enforced-only` (on `check`, `test` and `diff`) keeps only enforced
specs. A pipeline can then block on enforced specs and stay advisory for the rest. See
[`workflows.md`](workflows.md).

```yaml
behavior: Order lifecycle
enforced: true
```

## `entity`

| Key | Required | Notes |
|---|---|---|
| `name` | yes | |
| `state` | yes | code field holding the state → `stateField` |
| `states` | yes | non-empty, unique |
| `initial` | yes | must be in `states` |
| `terminal` | no | each must be in `states`; default `[]` |

## `actors.<name>`

| Key | Required | Notes |
|---|---|---|
| `trust` | yes | `untrusted` \| `authenticated` \| `signed-webhook` \| `internal` |
| `requires` | no | guard or list of guards (see Guards) this actor must pass on every transition it performs; default `[]` |

## `transitions.<name>`

| Key | Required | Default | Notes |
|---|---|---|---|
| `from` | yes | | state, list of states, or `"*"` |
| `to` | yes | | state |
| `by` | yes | | actor or list of actors; a list means **any one** of them (see below) |
| `requires` | no | `[]` | guard or list of guards every caller must pass, whichever actor it acts as |
| `effects` | no | `[]` | list; each item is `name` (→ `exactly-once`) or `{ name: multiplicity }` with multiplicity `exactly-once` \| `at-least-once` \| `idempotent` |
| `atomic` | no | `false` | state check + write are one indivisible step |
| `idempotent` | no | `false` | the event may be delivered more than once |
| `after` | no | | duration like `30m`, `2h`, `7d` (informational) |
| `impl` | no | | `path/to/file.ts#symbol`; also `#Class.method`, `#Class.#privateMethod`, `#obj.method` |

### Who may perform a transition: `by` and `requires`

Each actor in `by` is an alternative. A call is authorized when it passes the transition's own `requires`
**and** all the `requires` of at least one listed actor. The transition's `requires` applies to everyone; an
actor's `requires` applies only to callers acting as that actor.

```yaml
actors:
  customer: { trust: authenticated, requires: owner }
  admin: { trust: authenticated, requires: role(admin) }

transitions:
  cancel:
    from: paid
    to: cancelled
    by: [customer, admin]      # the order's owner, or an admin
    requires: [verified]       # either way, the caller is verified
    impl: src/orders/cancel.ts#cancelOrder
```

Code like `if (isAdmin(actor)) requireRole(actor, "admin"); else requireOwner(actor, order);` (plus a
`verified` guard on every path) conforms: each path to the write passes `verified` and one actor's guards.
Code that calls only `requireOwner` on some path and no guard on another does not
(`guard-not-dominating`, naming what each actor is missing).

## Guards

`name` or `name(arg, …)`, e.g. `owner`, `role(admin)`. Canonical form (`GuardRef.raw`) has no inner spaces
around the parens and `", "` between args. Bindings are keyed by the canonical form.

Inside a flow mapping or list (`{ … }`, `[ … ]`) a comma ends the value, so quote a guard with several
arguments there: `member: { trust: authenticated, requires: "role(owner, admin)" }`,
`requires: ["role(owner, admin)", verified]`. Unquoted, the spec is rejected (`unknown key "admin)"`, with a hint
to quote it). In block style (`requires: role(owner, admin)` on its own line) no quotes are needed.

## `rules[]`

Each item has `name` plus **exactly one** of `always`, `never`, `eventually`, whose value is an expression:

```
expr    := implies
implies := or ( "implies" or )*          (right-associative)
or      := and ( "or" and )*
and     := not ( "and" not )*
not     := "not" not | atom
atom    := "status" ("==" | "!=") STATE
         | "status" "in" "[" STATE ("," STATE)* "]"
         | "count" "(" "effect" EFFECT ")" CMP INT
         | "true" | "false"
         | "(" expr ")"
CMP     := "==" | "!=" | "<" | "<=" | ">" | ">="
STATE   := identifier (must be a declared state)
EFFECT  := dotted identifier (must be an effect declared on some transition)
```

Semantics: `always` holds in every reachable state; `never` holds in none; `eventually` means that from every
reachable state, a state where it holds can still be reached (AG EF: it need not happen on every run, only stay
possible). The explored states have no cycles (each invocation runs at most once, up to `concurrency`), so every
run ends in an **end state**, where no transition can fire any more, and AG EF comes down to: the expression holds
in every end state. That is how it is checked and reported ("can end in status `x` where it never holds"). End
states that exist only because the invocation bound ran out (one more invocation could still move) are skipped.

## `concurrency`

| Key | Default | Notes |
|---|---|---|
| `default` | `2` | invocations explored per transition |
| `max_parallel` | `{}` | map transition → positive integer, overrides `default` |

## `bindings`

| Key | Notes |
|---|---|
| `storage` | how the entity is stored: a preset, or the app's own storage functions (see below); omitted → auto-detected |
| `clients` | map name → `{ module, export, reads? }`. `export` is a value (an object, a function, an instance), or a class, an interface or a type alias (`export type Notifier = { … }`): then every value typed as it is the client (no generated tests for such a spec). `reads`: call paths below the client that only read (`isEnabled`, or `prices` for every `prices.*` call); calls to them are not effects. An effect in `effects` mapped to one of them is an error |
| `guards` | map canonical guard → `path#symbol` or `path#symbol(args)`. Each argument is a string (`"admin"` or `'admin'`), a bare word or number, `true`/`false`, or a list of those (`["owner", "admin"]`); anything else (an object, a call) is a spec error, since it could never match a call |
| `effects` | map effect name → code call path (`client.member.path`); omitted → name is the path |

`persistence: assign | prisma | memory` is still accepted as an alias of the preset form, so existing specs keep
working. It can't be combined with `storage`. `drizzle` (in either form) is a reserved name: the spec is valid,
but there is no Drizzle preset yet, so `tsverify check` reports one `unanalyzable` warning and extracts no code
model. A project that imports `drizzle-orm` without `bindings.storage` is treated the same way. Name the app's
own storage functions instead (the named-function form below), which works whatever the database.

### `bindings.storage`

**Preset form.** One of the built-in storage styles. IR: `Bindings.persistence`.

| Preset | Code shape |
|---|---|
| `assign` | repository objects on a bound client (`db.orders.get` / `save`, `db.transaction`) and plain assignment |
| `prisma` | a Prisma client bound in `clients` |
| `memory` | in-process objects with no client; atomic means no `await`/`yield` between the state check and the write |

```yaml
bindings:
  storage: prisma
```

**Named-function form.** The app's own functions, which tsverify treats as the storage boundary without looking
inside them (Prisma, SQL, Redis or an HTTP call are all the same to it). IR: `Bindings.storage`
(`StorageBinding`).

```yaml
bindings:
  storage:
    key: id                                     # the entity's key field; default `id`
    read:   src/orders/repo.ts#getOrder         # loads one entity by key
    save:   src/orders/repo.ts#saveOrder        # persists an entity
    update: src/orders/repo.ts#setStatusIf      # conditional save: checks the state and saves in one step
    atomic: src/db.ts#withTransaction           # runs its callback as one indivisible step (declared, not proven)
```

| Key | Notes |
|---|---|
| `key` | the entity's key field (default `id`); generated tests seed `fixtures.entity[key]` |
| `read` | function(s) that load one entity by key |
| `save` | function(s) that persist an entity |
| `update` | conditional save(s): check the stored state and save in one step (`UPDATE … WHERE status = 'paid'`) |
| `atomic` | function(s) that run a callback as one indivisible step. **Declared, not proven**: tsverify trusts it |

At least one `read`, `save` or `update` is required. Each of the four takes a function, or a list of them. A
function is written `path/to/file.ts#symbol` (`#repo.get` for a method of an exported object), or in the long form:

```yaml
update:
  - src/orders/repo.ts#setStatusIf                       # default roles: [key, from, to]
  - fn: src/orders/repo.ts#markShipped                   # markShipped(id): from and to are fixed
    from: [paid]
    to: shipped
    returns: count
read: { fn: src/orders/repo.ts#findOrder, args: [_, key] }   # findOrder(tenant, id)
save: { fn: src/orders/repo.ts#patchOrder, args: [key, patch] }
```

| Long-form key | Kinds | Notes |
|---|---|---|
| `fn` | all | `path#symbol` |
| `args` | all | the role of each positional argument (below), or, for an argument that is an object of named arguments, a map of its fields' roles (`[{ id: key }]`); default: read `[key]`, save `[entity]`, update `[key, from, to]` without the roles a fixed `from` / `to` replaces, atomic `[callback]` |
| `returns` | update | what the conditional save returns: `changed` (default: `true`, or `false` when the state check fails), `count` (rows changed: `1` or `0`, or an object with that `count`, as Prisma's `updateMany` returns), `entity` (the updated entity, or `undefined`), `throws` (it throws when the check fails, and returns nothing useful on success) |
| `from` | update | fixed from-state(s), when no argument has the `from` role; declared states |
| `to` | update | fixed target state, when no argument has the `to` role; a declared state |

Argument roles:

| Role | The argument is | Allowed on |
|---|---|---|
| `key` | the entity's key | read, save, update |
| `entity` | a whole entity | save |
| `patch` | some fields of an entity, merged into the stored one | save, update |
| `from` | the state, or list of states, the conditional save requires | update |
| `to` | the state the conditional save sets | update |
| `callback` | the function the atomic function runs. In generated tests the fake calls it with one argument, a stand-in for the transaction (see below) | atomic |
| `_` | anything tsverify should ignore | all |

A role is one positional argument, or a field of one. For a function that takes one object of named arguments
(`getOrder({ tx, id })`), give the roles of its fields as a map in that argument's place; fields it doesn't name
are ignored, and a nested object is a nested map:

```yaml
read:   { fn: src/orders/repo.ts#getOrder, args: [{ id: key }] }                  # getOrder({ tx, id })
save:   { fn: src/orders/repo.ts#savePatch, args: [{ where: { id: key }, data: patch }] }
update: { fn: src/orders/repo.ts#setStatusWhere, args: [{ id: key, from: from, to: to }] }
```

`key`, `entity`, `patch`, `from` and `to` can be fields; `callback` and `_` can't (an empty map `{}` is an
error too). The code check reads a field of an object written into the call (`getOrder({ tx, id: orderId })`),
and the generated tests' fake takes the value from that field. A bare `key`, `from` or `to` role on an argument
whose type is an object, or a field role the parameter's type doesn't have, gets an `unanalyzable` warning
(`…:binding:storage.<symbol>.args`) whose hint gives the field form.

How the code check and the generated tests see these functions:

- a call to one is recognised by the callee's resolved symbol (imports, renamed re-exports, namespace imports
  and bound methods included), never by name, and is a storage call site `storage.<symbol>` (`CallSite` with
  `client: "storage"`); tsverify never looks inside the functions
- the write is an assignment or spread on the entity a `read` returned, committed by a later `save` of it; the
  state field in a `patch` passed to a `save`; or a call to an `update`, whose `to` argument (a literal type)
  or fixed `to` is the target and whose `from` argument (a literal, literal union, or array or tuple of them)
  or fixed `from` gives the from-states
- a conditional save is atomic on its own (`AtomicScope.kind: "conditional-update"`); a read and save inside the
  `callback` of an `atomic` function, also through helpers, is atomic **as declared** (`kind: "declared"`), and
  `tsverify check` says so (`specs[].declaredAtomic` in JSON); a read outside and a save inside is not atomic
- an unconditional update (a fixed `from` with every state) after a `read` of the same key whose state the code
  checks writes from the checked states; it is atomic only when the read and the update run inside one `atomic`
  function's callback (as declared), else `non-atomic`. A check on the rows of a list read before it gives an
  unknown from-state (`unanalyzable`) and is not atomic outside such a callback either
- `returns` tells the code check which branch runs when an update saved nothing: effects only there are not the
  transition's, and an effect that can run before the update's result is checked makes it `non-atomic`
- a write that no named function saves is `unanalyzable` (`--strict`: an error)
- `tsverify test` replaces each named function with an in-memory version (`instrument.storage`) by mocking its
  module; the module's other exports stay real. The fake of an `atomic` function calls its callback with one
  argument: a stand-in for the transaction (or lock handle) the real function passes. Passing it on to the bound
  functions and clients is fine (they take it as a `_` argument); any other use of it (`tx.insert(…)`) throws an
  error naming what was used, since only code the spec doesn't bind uses it. So each must be exported (or be a method of an export): `check`
  reads the calls of one that isn't as usual, and `test` generates no tests for the spec (`not-generated`, saying
  which function)

Errors (`invalid-spec`, at the offending YAML node):

- `persistence` and `storage` together
- no `read`, `save` or `update` function
- a malformed `path#symbol`; an unknown role, kind or long-form key (with a did-you-mean hint)
- a read without `key`; a save without `entity` or `key` + `patch`, or with both `entity` and `patch`; an
  update without `key`; an atomic function without `callback`
- an update without its from-states (a `from` argument or a fixed `from:`) or its target (a `to` argument or a
  fixed `to:`), or with either given both ways; a fixed state that isn't declared
- a role used twice in one function (`_` may repeat), or a role the kind doesn't take; `_` or `callback` as a
  field role, or an object argument that names no field (`{}`)
- the same symbol name twice anywhere in the block (call sites are labelled by name)
- a `bindings.clients` entry named `storage` (the gates `storage.<symbol>` are the named functions')

## `fixtures`

Values `tsverify test` uses to drive the real code. Opaque YAML values, passed through as JSON.

| Key | Notes |
|---|---|
| `entity` | fields of a seeded entity, apart from the state field (each test sets it) |
| `actors` | value per actor name, passed where the impl takes an actor |
| `args` | per-transition argument list overriding the default; the strings `$id` and `$actor` are replaced by the seeded entity's key and the acting actor's fixture |

```yaml
fixtures:
  entity: { id: o1, ownerId: c1, email: c1@example.com, chargeId: ch_1 }
  actors:
    admin: { id: a1, roles: [admin] }
  args:
    payment_succeeded: [{ id: evt_1, orderId: $id, chargeId: ch_1 }]
```

## Semantic validation (beyond the schema)

All reported as `invalid-spec` with the YAML location:

- `initial`, `terminal`, every `from`/`to` refer to declared states
- every `by` refers to a declared actor
- `max_parallel` keys refer to declared transitions
- `fixtures.actors` keys are declared actors; `fixtures.args` keys are declared transitions
- rule `STATE`s are declared; rule `EFFECT`s are declared on some transition
- effect names are unique within a transition
- every guard used in `requires` (transition or actor) has a binding **if** `bindings.guards` is non-empty
  (a spec with no guard bindings at all is allowed — e.g. a design-only spec)
- `bindings.storage`: see [its errors](#bindingsstorage)
- `bindings.effects` keys are effects declared on some transition
- the first segment of each `bindings.effects` call path (`stripe` in `stripe.refunds.create`) is a
  `bindings.clients` key, **if** `bindings.clients` is non-empty
- terminal states have no outgoing transitions (warning, not error)
- every `bindings.guards` entry is required by some transition or actor (warning, not error: "unused guard
  binding"). Clients are not checked this way: a persistence client such as `db` is legitimately referenced
  by no effect or guard
