# Behavior file format (v1)

`*.behavior.yaml` files describe intended behavior. `@tsverify/spec` (zod schema in `packages/spec/src/schema.ts`) is the
executable source of truth; this page is its human reference. Canonical example:
[`packages/spec/test/fixtures/valid/order.behavior.yaml`](../packages/spec/test/fixtures/valid/order.behavior.yaml).

## Paths

`impl`, `bindings.clients.*.module` and `bindings.guards` paths are relative to the **project root**: the nearest
directory at or above the behavior file that contains a `tsconfig.json` (overridable with `tsverify check --project`).

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
| `requires` | no | guard or list of guards (see Guards); default `[]` |

## `transitions.<name>`

| Key | Required | Default | Notes |
|---|---|---|---|
| `from` | yes | | state, list of states, or `"*"` |
| `to` | yes | | state |
| `by` | yes | | actor or list of actors |
| `requires` | no | `[]` | guard or list of guards |
| `effects` | no | `[]` | list; each item is `name` (→ `exactly-once`) or `{ name: multiplicity }` with multiplicity `exactly-once` \| `at-least-once` \| `idempotent` |
| `atomic` | no | `false` | state check + write are one indivisible step |
| `idempotent` | no | `false` | the event may be delivered more than once |
| `after` | no | | duration like `30m`, `2h`, `7d` (informational) |
| `impl` | no | | `path/to/file.ts#symbol` |

## Guards

`name` or `name(arg, …)`, e.g. `owner`, `role(admin)`. Canonical form (`GuardRef.raw`) has no inner spaces
around the parens and `", "` between args. Bindings are keyed by the canonical form.

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

Semantics: `always` holds in every reachable state; `never` holds in none; `eventually` means from every reachable
state a satisfying state is reachable (AG EF — weaker than LTL with fairness).

## `concurrency`

| Key | Default | Notes |
|---|---|---|
| `default` | `2` | invocations explored per transition |
| `max_parallel` | `{}` | map transition → positive integer, overrides `default` |

## `bindings`

| Key | Notes |
|---|---|
| `persistence` | `assign` \| `prisma` \| `drizzle` \| `memory`; omitted → auto-detected. `memory`: in-process objects with no client, where atomic means no `await`/`yield` between the state check and the write |
| `clients` | map name → `{ module, export }` |
| `guards` | map canonical guard → `path#symbol` or `path#symbol(args)` |
| `effects` | map effect name → code call path (`client.member.path`); omitted → name is the path |

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
- `bindings.effects` keys are effects declared on some transition
- the first segment of each `bindings.effects` call path (`stripe` in `stripe.refunds.create`) is a
  `bindings.clients` key, **if** `bindings.clients` is non-empty
- terminal states have no outgoing transitions (warning, not error)
- every `bindings.guards` entry is required by some transition or actor (warning, not error: "unused guard
  binding"). Clients are not checked this way: a persistence client such as `db` is legitimately referenced
  by no effect or guard
