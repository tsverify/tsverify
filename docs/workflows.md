# Using `tsverify` in CI

`tsverify` never decides policy. It returns a fixed exit code and machine-readable output, and your CI decides what
blocks a merge. This page covers the three recommended
workflows, the exit codes they build on, and where each output format goes.

A ready-to-copy GitHub Actions workflow that does all of this is in
[`examples/ci/github/tsverify.yml`](../examples/ci/github/tsverify.yml).

## Exit codes

Every command returns one of these. Output never changes shape based on where it goes, so CI asks for a format
explicitly.

| Code | Meaning | Typical CI reaction |
|---|---|---|
| `0` | No error-severity findings (warnings and info never fail a run). For `tsverify diff`: the diff was computed, whether or not anything changed | pass |
| `1` | Violations: behavior bugs or conformance mismatches (`check`, `test`); with `--strict`, also code `tsverify` could not analyze | your choice: see the workflows below |
| `2` | Invalid input: a spec that doesn't parse or validate, a broken `impl` link, bad CLI usage; for `tsverify diff` also an unknown ref or no git repository | fail: the run could not do its job |
| `3` | Internal error in `tsverify` | fail, and please report it |

Invalid input (2) takes precedence over violations (1).

## Outputs and where they go

| Format | Commands | For | Where it goes |
|---|---|---|---|
| `pretty` (default) | `validate`, `check`, `test`, `diff` | people at a terminal and CI logs | stdout |
| `json` | `validate`, `check`, `test`, `diff` | scripts and agents | an artifact, or piped into `jq` |
| `sarif` | `validate`, `check`, `test` | code scanning (annotations on the PR, the Security tab) | upload with `github/codeql-action/upload-sarif` |
| `markdown` (default for `diff`) | `diff` | reviewers | a PR comment |

- **JSON** (`check`, `test`, `validate`): `{ version: 1, findings, specs, summary }`. Every finding has a stable `id`,
  `category`, `severity`, `message`, and `specAt` / `codeAt` locations relative to the cwd (also when they are
  outside it: `../…`; only the pretty output shows those as absolute paths); a consequence has `causedBy`, the ids
  of the findings that explain it. `specs[].enforced` is present (and `true`) for specs marked `enforced: true`;
  `strict: true` is present for a `--strict` run. Bumping `version` is a breaking change. Per spec:
  - `stats` (the spec's model) and `codeStats` (the model extracted from the code), from the model checker:
    `states` (distinct states explored), `edges` (steps explored between them, including into states already seen),
    `complete` (`false` when `--max-states` stopped the search: results are incomplete) and `boundLimitedDeadlocks`
    (end states reached only because every invocation the checker allows was used up; one more invocation would
    go on, so they are artefacts of the bound and never reported as stuck).
  - `extract` (`check`, `test`; the same for every spec of one project): `files` (source files read: the
    tsconfig's files, without declaration files and `node_modules`), `writes` (candidate state writes found in
    the syntax, for every spec's state field, before they are matched to a spec's entity) and `probes` (narrowing
    probes injected to read from-states: one per candidate write whose entity is a plain reference, `order` or
    `this.order`).
  - `project` (`check`, `test`): the project root, relative to the cwd; `null` with `--spec-only` or without a
    `tsconfig.json`. `declaredAtomic` (`check`): transitions atomic only because the spec declares a function
    atomic. `generated` (`test`): the generated directory, `<project>/.tsverify/generated/<spec-slug>/` (relative to the
    cwd), and the test counts; absent when no test was generated.
- **JSON** (`diff`): `{ version: 1, base: { ref, commit }, head: "working tree", specs: [{ file, enforced?, diff }],
  summary }`, where `diff` is the `BehaviorDiff` from `@tsverify/ir` (field changes as `base` / `head` strings).
- **SARIF 2.1.0**: one run, tool `tsverify`, one rule per finding category. Each result's primary location is the code
  site when there is one, else the spec; the other one is a related location. URIs are relative to the cwd under
  `%SRCROOT%`, so **run `tsverify` from the repository root** (or set `checkout_path` on the upload). The finding id is
  the `partialFingerprints` entry `tsverifyFindingId/v1`, so code scanning tracks a finding across pushes.
  `properties` carry `behavior`, `transition`, `property`, `enforced`, `strict` (an `unanalyzable` result that
  `--strict` raised to `error`), `causedBy` (ids of the findings this one is a consequence of) and a compact `trace`
  (one line per step).
- **Markdown** (`diff`): one section per added, removed or changed behavior, with a one-line summary
  (`+1 transition, ~1 transition, −1 rule`), a Mermaid diagram of the head state machine with added (`+`, thick),
  removed (`−`, dotted) and changed (`~`) edges and states, and a `base → head` table per kind of change. The
  markers are text, so the diff reads the same in any GitHub theme. The first line is `<!-- tsverify-diff -->`, which
  lets CI find and update its own comment.

## Workflow 1: advisory (never block)

Run everything, show the results, never fail on findings. Good for adopting `tsverify` on an existing codebase.

```sh
tsverify check --format sarif > tsverify.sarif || [ $? -eq 1 ]   # upload tsverify.sarif to code scanning
tsverify diff --base origin/main > tsverify-diff.md              # post as a PR comment
```

`|| [ $? -eq 1 ]` turns "violations found" into success while still failing on invalid input (2) and internal
errors (3).

## Workflow 2: blocking (fail on exit 1)

Any violation fails the job. Add `--strict` (recommended when blocking):

```sh
tsverify check --strict --format sarif > tsverify.sarif    # exit 1 fails the step
```

Upload the SARIF in a step that runs even when this one fails (`if: always()` on GitHub), so reviewers see why.
Add `tsverify test --strict` as a second blocking step to also run the generated tests (paths, forbidden states,
guards and counterexample replays); its findings are generated-test results only, plus, with `--strict`, the
`unanalyzable` ones.

### `--strict`

`check` and `test` report an `unanalyzable` finding as a **warning** by default: `tsverify` could not analyze
something, such as a state field typed `string`, a state write whose value is not a literal or that is built in a
shape it can't read (and the transitions it would confirm: "couldn't confirm that … writes …"), a write saved
outside the storage the spec names, a read it cannot place in an atomic scope, or a model that hit `--max-states`. A warning never fails a run, so reshaping code into
a form `tsverify` cannot read would quietly turn an error into a pass. `--strict` reports those warnings as
**errors**, so the run exits 1:

- JSON: their `severity` is `error`, they count in `summary.errors`, and the document has `strict: true`.
- SARIF: their `level` is `error`, with `properties.strict: true`.
- Pretty: they print as `✗ unanalyzable` (`✗ not-generated` for `test`), and a line says how many `--strict` raised.
- `tsverify test --strict` also reports the static `unanalyzable` warnings (normally left to `check`), since the
  generated tests cannot cover what the extractor could not read. And a transition with an `impl` that got no
  generated test at all is an error (its `not-generated` finding is raised, or one is added), and so is a spec
  that got no test while it has such transitions: "0 generated tests" never passes a strict run. A single test
  kind that can't be generated (a guard test for an actor without a fixture, a replay) stays `info`.
- `unanalyzable` infos stay infos: a transition without `impl` is the spec's own choice, visible in review.

Fix the code (or the spec) until a strict run is clean, rather than dropping the flag.

## Workflow 3: blocking only for enforced specs

Mark the specs your team wants CI to block on with `enforced: true` at the top level of the behavior file (see
[`behavior-format.md`](behavior-format.md#enforced)). Then report everything, but gate on the enforced ones:

```sh
tsverify check --format sarif > tsverify.sarif || [ $? -eq 1 ]   # advisory: every spec, uploaded
tsverify check --enforced-only                               # blocking: enforced specs only
```

`--enforced-only` (on `check`, `test` and `diff`) keeps only specs with `enforced: true`:

- With none, the run is empty and exits 0; the pretty output says why.
- Invalid specs are always kept: an invalid spec may be an enforced one, and breaking it must not take it out of
  a blocking run. They exit 2.
- For `diff`, a spec counts as enforced when either side has `enforced: true`, so turning enforcement off shows up
  in the diff.

SARIF results carry `properties.enforced: true` as well, for tools that filter on it.

## The behavior diff on pull requests

```sh
tsverify diff --base origin/main [paths…] [--format markdown|json|pretty] [--enforced-only]
```

- **Head** is the working tree: specs are found the way `check` finds them (`**/*.behavior.yaml` under the given
  paths, default the cwd, skipping `node_modules`, `.git`, `.tsverify` and `dist`).
- **Base** is the same paths at `<ref>`, read with the local `git` binary (`git ls-tree`, `git show`); no network.
  The ref must exist locally, so CI needs the base branch's history (`fetch-depth: 0` on `actions/checkout`, or a
  `git fetch origin <base>`).
- Specs are **paired by path**. A renamed or moved behavior file shows as one removed and one added behavior.
- The diff covers the behavior name and `enforced`, the entity (name, state field, initial state), states
  (incl. terminal), transitions (from, to, by, requires, effects, atomic, idempotent, after, impl, concurrency),
  actors, rules and bindings. `summary` and `fixtures` are not compared.
- Each path is read from the git repository that contains it, not the cwd's, so `tsverify diff --base HEAD
  ../other-repo/x.behavior.yaml` works from anywhere; paths in several repositories are each compared with `<ref>`
  in their own (JSON: `base.commits`).
- Exit 0 whether or not anything changed; CI decides whether a behavior change needs extra review. Exit 2 for an
  invalid spec on either side (base-side findings are located as `<ref>:<file>`), an unknown ref, or a path outside
  any git repository.

The example workflow posts the Markdown as a single PR comment and edits it on every push (found by its
`<!-- tsverify-diff -->` marker) instead of adding a new comment each time.
