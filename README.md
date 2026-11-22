<img src="assets/icon.svg" width="64" height="64" alt="">

# ts-verification (`tsv`, working name)

Verify TypeScript code against human-readable **behavior files** (`*.behavior.yaml`): agents write the code
*and* the behavior spec; `tsv` renders the spec as diagrams, model-checks it, extracts what the code actually
does, and turns every mismatch into a failing test. Local-only: install + YAML files, nothing else.

> Status: pre-alpha, under construction. Design log: [`idea/`](idea/) · Format: [`docs/behavior-format.md`](docs/behavior-format.md)

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
