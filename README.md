<img src="assets/icon.svg" width="64" height="64" alt="">

# tsverify

Verify TypeScript code against human-readable **behavior files** (`*.behavior.yaml`): agents write the code
*and* the behavior spec; `tsverify` renders the spec as diagrams, model-checks it, extracts what the code actually
does, and turns every mismatch into a failing test. Local-only: install + YAML files, nothing else.

> Status: pre-alpha, under construction. Format: [`docs/behavior-format.md`](docs/behavior-format.md)

## Quick start

**1. Install.** *Placeholder: `tsverify` is not published yet.* Once it is, it is a dev dependency
(Node.js 22.12 or later):

```sh
npm i -D @tsverify/cli          # then npx tsverify …
npm i -D @tsverify/cli vitest   # if you want `tsverify test`, which runs the generated tests with your vitest (3.0.5+, 4.0.1+ or 5)
```

`check`, `view`, `diff`, `render`, `validate` and `schema` need nothing else; without vitest, `tsverify test` says so
and exits 2. Until it is published, run it from a checkout of this repository with `pnpm install`, then
`pnpm tsverify <command>`.

tsverify bundles no TypeScript: it reads your code with **your project's** `typescript`, through the compiler API
of TypeScript 5.4–6.x, so those projects need nothing else. TypeScript 7 no longer ships that API: a TS-7 project
also adds Microsoft's `@typescript/typescript6` (`npm install --save-dev @typescript/typescript6`), which tsverify
uses instead.

**2. Write a spec** next to the entity it describes, e.g. `src/orders/order.behavior.yaml`:

```yaml
# tsverify:example
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
tsverify check --spec-only    # model-check the spec alone: design bugs, with a counterexample trace
tsverify check                # also extract what the code does and compare (exit 0 ok · 1 violations · 2 invalid input · 3 internal)
tsverify check --strict       # in blocking CI: code tsverify can't analyze is an error, not a warning
tsverify test                 # generate and run tests from spec + code; replays turn counterexamples into failing tests
tsverify diff --base main     # behavior diff (Markdown + Mermaid) for the PR
tsverify view                 # local viewer: diagram, matrix, findings, counterexample playback, live reload
```

`tsverify test` writes the generated tests to `.tsverify/generated/` and runs them with the project's vitest
(step 1). To run them in your own `vitest run` too, also add `@tsverify/runtime` (the same version as
`@tsverify/cli`) as a devDependency.

`tsverify view` serves on 127.0.0.1 only ([docs/viewer.md](docs/viewer.md)); `tsverify render <spec> --mermaid` prints the
diagram as text.

**Next:**

- [Authoring guide](docs/authoring-guide.md): writing specs for new code, and **as-is specs for existing code**;
  what each finding means; which code shapes `tsverify` understands.
- [Agent kit](docs/agents/): the `AGENTS.md` / `CLAUDE.md` snippet for coding agents, and a checklist for
  reviewing their PRs.
- [Format reference](docs/behavior-format.md): every key of `*.behavior.yaml`.
- [CI workflows](docs/workflows.md): advisory, blocking, or blocking only for `enforced: true` specs.
- Editor completion: point `yaml-language-server` at `node_modules/@tsverify/cli/behavior.schema.json`
  ([how](docs/authoring-guide.md#9-editor-support-json-schema)).

## Using tsverify in CI

`tsverify` returns fixed exit codes (0 ok · 1 violations · 2 invalid input · 3 internal) and never decides policy;
your CI does. [`docs/workflows.md`](docs/workflows.md) covers the three recommended setups (advisory, blocking,
and blocking only for specs marked `enforced: true`) and the outputs: `--format json`, `--format sarif` for code
scanning, and `tsverify diff --base <ref>` for a Markdown behavior diff with a Mermaid diagram as a PR comment.
A ready-to-copy GitHub Actions workflow: [`examples/ci/github/tsverify.yml`](examples/ci/github/tsverify.yml).

## Development

```sh
pnpm install
pnpm run ci      # lint + typecheck + test
```

## License

[Apache License 2.0](LICENSE). Copyright 2026 The tsverify Authors; see [`NOTICE`](NOTICE).

Files tsverify **generates** in your project, such as the tests under `.tsverify/generated/`, are yours. The license
places no conditions on them.
