<img src="assets/icon.svg" width="64" height="64" alt="">

# ts-verification (`tsv`, working name)

Verify TypeScript code against human-readable **behavior files** (`*.behavior.yaml`): agents write the code
*and* the behavior spec; `tsv` renders the spec as diagrams, model-checks it, extracts what the code actually
does, and turns every mismatch into a failing test. Local-only: install + YAML files, nothing else.

> Status: pre-alpha, under construction. Design log: [`idea/`](idea/) · Format: [`docs/behavior-format.md`](docs/behavior-format.md)

## Development

```sh
pnpm install
pnpm run ci      # lint + typecheck + test
```

Repository layout and package ownership: [`idea/6. repo-structure.md`](idea/6.%20repo-structure.md).
