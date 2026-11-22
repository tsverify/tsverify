# Changelog

All notable changes to tsverify are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.0]

The first alpha, not published yet: packaging comes later, and the packages are still versioned `0.0.0`. It covers
the whole pipeline, from a `*.behavior.yaml` spec to model checking, code conformance and generated tests against
the real code.

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
- A JSON Schema of the format, checked in as `@tsverify/spec/behavior.schema.json` with a drift test, for
  `yaml-language-server` and agents.

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
- Licensed under the Apache License 2.0. Files tsverify generates in your project are yours.
