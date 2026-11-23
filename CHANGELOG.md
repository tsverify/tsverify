# Changelog

All notable changes to tsverify are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Smaller install.** `@tsverify/cli` no longer installs Mermaid, vitest, yaml, zod, cac or picocolors: about
  231 MB of `node_modules` became 17 MB (most of it ts-morph). The viewer ships prebuilt with only the part of
  Mermaid it uses (state diagrams, about 0.8 MB, loaded lazily, still offline and under the same CSP), and the
  small pure-JS packages are bundled into `dist/tsverify.js`. Their licenses are in
  `dist/THIRD_PARTY_NOTICES.md` (see `NOTICE`).
- **vitest is an optional peer dependency** (`^3.0.5 || ^4.0.1 || ^5.0.0`). Only `tsverify test` needs it:
  install it with `npm i -D vitest`. `tsverify test` uses the project's vitest, else one installed next to
  tsverify. Without one it exits 2 with "tsverify test runs the generated tests with vitest, which isn't
  installed: npm i -D vitest"; with a version outside the range it exits 2 and names the version and where it
  found it. Every other command works without vitest.
- `by: [a, b]` means **any** listed actor: a call is authorized when it passes the transition's own `requires`
  and all the `requires` of at least one listed actor. `guard-not-dominating` used to require every listed
  actor's guards at once, which flagged correct owner-or-admin code and accepted owner-and-admin code. It now
  reports each path to the write (`CodeSites.guardSets`) that passes no listed actor's guards in full, once,
  naming what each actor is missing; without enumerated paths it falls back to the dominating guards. A
  single-actor `by` is checked as before.
- The plain-English summary reads a multi-actor `by` as alternatives and states the transition's `requires`
  once, for every caller; the permission matrix legend says any one row's guards suffice.
- Generated guard tests follow "any": besides rejecting actors outside `by`, each other listed actor with a
  fixture must succeed on its own. Failing one actor's guards can't be expressed with one fixture per actor and
  is reported as `not-generated`.
- An unknown from-state (a state field typed `string`) is reported once, as the extractor's `unanalyzable`
  warning, no longer also as `from-state-unconstrained`.
- `from-state-unconstrained` points at the first `from` item of the transition.
- The `non-atomic` hint for `memory` persistence asks for a synchronous check and write (no `await`/`yield`
  between them) instead of a transaction or conditional update.
- tsverify no longer bundles TypeScript (ts-morph and its private TypeScript 6.0.2, about 15 MB): it reads code
  with the analyzed project's own `typescript`.
- **TypeScript 7 or later is required.** tsverify reads code through TypeScript 7's API (`typescript/sync`;
  `typescript/unstable/sync` on 7.0), which runs the project's native compiler, and no longer supports
  TypeScript 5 or 6 or `@typescript/typescript6`. `typescript` (`>=7.0.0`) is an optional peer dependency of
  `@tsverify/cli`. On TypeScript 5 or 6, `check` and `test` exit 2: "tsverify needs TypeScript 7 or later to read
  your code. This project has TypeScript 5.9.3: upgrade it with `npm i -D typescript@latest`." A tsconfig that
  TypeScript 7 rejects (it removed options TypeScript 6 only deprecated, such as `baseUrl` and
  `moduleResolution: node10`) also exits 2, quoting TypeScript's message. Code models are unchanged.

### Added
- `--strict` on `check` and `test`: `unanalyzable` warnings are reported as errors (exit 1), so code tsverify
  can't analyze can't hide a finding. JSON has `strict: true`, SARIF results `level: error` and
  `properties.strict`. Recommended for blocking CI ([`docs/workflows.md`](docs/workflows.md)).
- Generated tests support clients bound as a bare exported function (call sites with `path: ""`, gate = the
  client name): `instrument.effects` accepts the `""` call path and makes the fake client a recording function.

### Fixed
- `tsverify test` mocked each client module wholesale, so a guard or helper exported beside a client vanished
  (`No "requireOwner" export is defined on the mock`). The mocks now replace only the bound exports.

## [0.1.0-alpha.0]

The first alpha, packaged for npm but not published yet. It covers the whole pipeline, from a `*.behavior.yaml`
spec to model checking, code conformance and generated tests against the real code.

### Added

#### Spec format
- `*.behavior.yaml` v1 ([`docs/behavior-format.md`](docs/behavior-format.md)): `behavior`, `entity` (a TypeScript
  type with a literal-union state field, its states, initial and terminal states), `actors` with trust levels
  (`untrusted`, `authenticated`, `signed-webhook`, `internal`) and `requires` guards, `transitions` (`from`, `to`, `by`,
  `requires`, `atomic`, `effects` with `exactly-once` / `at-least-once` / `idempotent` multiplicity, `impl` links
  into the code), `rules` (`always`, `never`, `eventually` over `status` and `count(effect …)`), `concurrency`,
  `bindings` (persistence, clients, guards, effects), `fixtures` for generated tests, and the optional
  `enforced` flag for per-spec CI policy.
- YAML parsing with source positions, normalization to the shared `BehaviorModel`, and semantic validation with
  located, actionable findings (per-item locations for `from`, `by`, `requires` and `bindings.effects`;
  did-you-mean for unknown names; a warning for unused guard bindings).
- A JSON Schema of the format, checked in with a drift test and shipped as
  `@tsverify/cli/behavior.schema.json`, for `yaml-language-server` and agents.

#### Checker
- Explicit-state model checker (BFS) with a compact state encoding and symmetry reduction over concurrent
  workers. Non-atomic transitions split into a read and a write, so check-then-act races show up.
- `always` / `never` invariants and `eventually` (AG EF) liveness rules; built-ins for reachable states,
  `no-stuck-states`, effect multiplicity, guarded `untrusted` transitions and idempotent `signed-webhook`
  transitions.
- Shortest counterexample traces, exportable as ITF JSON, and a state budget (`--max-states`).
- The same checker runs on the spec model (`spec-property`) and on the model extracted from the code
  (`implementation-property`).

#### Extractor
- Builds the as-implemented `BehaviorModel` from TypeScript code: syntactic discovery of every state write in the
  project, probe-first type narrowing for the from-states at each write, link resolution, a call graph and guard
  dominance over a control-flow graph, effects on the write's path, and reads followed into helpers.
- Persistence adapters: `assign` (repository-style read, assign, save), `prisma` (recognized by call shape,
  including transactions, conditional `updateMany` and isolation levels) and `memory` (in-process objects, where
  atomicity means no `await` between the check and the write).
- `unanalyzable` findings with stable ids where the code can't be read.

#### Conformance
- Compares the spec model with the code model: `undeclared-transition`, `missing-transition`,
  `from-state-mismatch`, `from-state-unconstrained`, `guard-not-dominating`, `undeclared-effect`,
  `missing-effect` and `non-atomic`, each located at the spec item and the code.
- Code-model counterexamples are linked to the conformance finding that causes them (`causedBy`).

#### Test generation and runtime replay
- `@tsverify/testgen` generates vitest files from spec + code: path tests for allowed transitions, forbidden-state
  tests, guard tests, and counterexample replays. Tests it can't generate are reported as `not-generated`.
- `@tsverify/runtime`, imported by the generated tests: a replay scheduler that gates real async code at the
  model's read and write points, in-memory fakes for stores, effect clients and the Prisma client, and verdicts
  (`confirmed`, `confirmed-divergent`, `replay-disagrees`, `inconclusive`) with precise divergence messages.
- Generated tests run in-process under vitest, in `<project>/.tsverify/generated/`, without loading the project's
  own vitest config.

#### CLI
- `tsverify validate`: parse and validate specs.
- `tsverify check`: validate, model-check, extract and compare; `--spec-only`, `--project`, `--max-states`,
  `--enforced-only`.
- `tsverify test`: generate and run tests; failures and confirmed replays become `generated-test-failed` and
  `replay-confirmed` findings.
- `tsverify render <spec>`: Mermaid state diagram, actor × transition permission matrix, or plain-English
  summary.
- `tsverify schema`: print the JSON Schema.
- `tsverify diff --base <ref>`: behavior diff between the specs at a git ref and the working tree.
- `tsverify view`: a local viewer on loopback only (diagram, matrix, summary, findings by root cause, step-by-step
  counterexample playback) with live reload when specs or code change.
- Fixed exit codes: 0 ok, 1 violations, 2 invalid input, 3 internal error. Policy is left to CI.

#### Outputs
- `pretty` terminal output, with consequences grouped under their root cause.
- `--format json` for `validate`, `check`, `test` and `diff`, a stable contract for CI and agents.
- `--format sarif` for `validate`, `check` and `test`, with stable `tsverifyFindingId/v1` fingerprints for code
  scanning.
- Markdown for `tsverify diff` (the default), with a Mermaid diff diagram and a `<!-- tsverify-diff -->` marker for
  a sticky PR comment.

#### Docs and agent kit
- README quick start, the format reference, an authoring guide (specs for new code and as-is specs for existing
  code, what each finding means, the code shapes tsverify understands, fixtures, editor support), CI workflows
  (advisory, blocking, enforced-only), and the viewer guide.
- An example GitHub Actions workflow ([`examples/ci/github/tsverify.yml`](examples/ci/github/tsverify.yml)): SARIF
  upload, a mode gate and a sticky behavior-diff comment.
- Agent kit ([`docs/agents/`](docs/agents/)): an `AGENTS.md` / `CLAUDE.md` snippet and a review checklist for agent
  PRs.
- Example apps with seeded-bug variants: `examples/orders-app` (B1–B6) and `examples/orders-prisma` (B1–B7).
- Dogfooding: `pnpm verify` checks tsverify's own replay scheduler and viewer playback specs.

#### Project
- Named `tsverify`: the command is `tsverify`, and the packages use the `@tsverify` npm scope.
- Packaging: two published packages at `0.1.0-alpha.0`, `@tsverify/cli` (one esbuild bundle of the workspace with
  third-party dependencies external and the viewer app prebuilt, shipping `behavior.schema.json`) and
  `@tsverify/runtime` (compiled with `tsc`, zero dependencies); Node.js 22.12 or later. A pack smoke test
  (`pnpm smoke:pack`) installs both tarballs with npm into a copy of the example app, and a draft release workflow
  publishes on `v*` tags ([`RELEASING.md`](RELEASING.md)).
- Licensed under the Apache License 2.0. Files tsverify generates in your project are yours.
