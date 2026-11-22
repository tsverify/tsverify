<img src="assets/icon.svg" width="64" height="64" alt="">

# ts-verification (`tsv`, working name)

Verify TypeScript code against human-readable **behavior files** (`*.behavior.yaml`): agents write the code
*and* the behavior spec; `tsv` renders the spec as diagrams, model-checks it, extracts what the code actually
does, and turns every mismatch into a failing test. Local-only: install + YAML files, nothing else.

> Status: pre-alpha, under construction. Design log: [`idea/`](idea/) · Format: [`docs/behavior-format.md`](docs/behavior-format.md)

## Quick start

**1. Install.** *Placeholder: `tsv` is not published yet.* Once it is, it will be a dev dependency
(`npm install --save-dev <tsv package>`, then `npx tsv …`). Until then, run it from a checkout of this repository
with `pnpm install`, then `pnpm tsv <command>`.

**2. Write a spec** next to the entity it describes, e.g. `src/orders/order.behavior.yaml`:

```yaml
# tsv:example
behavior: Order lifecycle
entity:
  name: Order # the TypeScript type
  state: status # its literal-union state field
  states: [pending, paid, refunded]
  initial: pending
  terminal: [refunded]
actors:
  customer: { trust: untrusted, requires: owner }
  admin: { trust: authenticated, requires: role(admin) }
transitions:
  pay: { from: pending, to: paid, by: customer, atomic: true, impl: src/orders/pay.ts#payOrder }
  refund:
    from: paid
    to: refunded
    by: admin
    atomic: true
    effects: [stripe.refund]
    impl: src/orders/refund.ts#refundOrder # paths are relative to the nearest tsconfig.json
rules:
  - name: Refund at most once
    always: count(effect stripe.refund) <= 1
bindings:
  clients:
    db: { module: src/db.ts, export: db }
    stripe: { module: src/payments/stripe.ts, export: stripe }
  guards:
    owner: src/auth/guards.ts#requireOwner
    role(admin): src/auth/guards.ts#requireRole("admin")
  effects:
    stripe.refund: stripe.refunds.create
```

**3. Check it.**

```sh
tsv check --spec-only    # model-check the spec alone: design bugs, with a counterexample trace
tsv check                # also extract what the code does and compare (exit 0 ok · 1 violations · 2 invalid input · 3 internal)
tsv test                 # generate and run tests from spec + code; replays turn counterexamples into failing tests
tsv diff --base main     # behavior diff (Markdown + Mermaid) for the PR
tsv view                 # local viewer: diagram, matrix, findings, counterexample playback, live reload
```

`tsv view` serves on 127.0.0.1 only ([docs/viewer.md](docs/viewer.md)); `tsv render <spec> --mermaid` prints the
diagram as text.

**Next:**

- [Authoring guide](docs/authoring-guide.md): writing specs for new code, and **as-is specs for existing code**;
  what each finding means; which code shapes `tsv` understands.
- [Agent kit](docs/agents/): the `AGENTS.md` / `CLAUDE.md` snippet for coding agents, and a checklist for
  reviewing their PRs.
- [Format reference](docs/behavior-format.md): every key of `*.behavior.yaml`.
- [CI workflows](docs/workflows.md): advisory, blocking, or blocking only for `enforced: true` specs.
- Editor completion: point `yaml-language-server` at [`packages/spec/behavior.schema.json`](packages/spec/behavior.schema.json)
  ([how](docs/authoring-guide.md#9-editor-support-json-schema)).

## Using tsv in CI

`tsv` returns fixed exit codes (0 ok · 1 violations · 2 invalid input · 3 internal) and never decides policy;
your CI does. [`docs/workflows.md`](docs/workflows.md) covers the three recommended setups (advisory, blocking,
and blocking only for specs marked `enforced: true`) and the outputs: `--format json`, `--format sarif` for code
scanning, and `tsv diff --base <ref>` for a Markdown behavior diff with a Mermaid diagram as a PR comment.
A ready-to-copy GitHub Actions workflow: [`examples/ci/github/tsv.yml`](examples/ci/github/tsv.yml).

## Development

```sh
pnpm install
pnpm run ci      # lint + typecheck + test
```

Repository layout and package ownership: [`idea/6. repo-structure.md`](idea/6.%20repo-structure.md).
