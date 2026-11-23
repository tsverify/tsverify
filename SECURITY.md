# Security

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[private vulnerability reporting](https://github.com/tsverify/tsverify/security/advisories/new) ("Report a
vulnerability" on the Security tab). Do not open a public issue. You'll get an acknowledgement within a few days.
This is a pre-release project, so fixes go into the next release.

## Security model

tsverify is a local developer tool. It is worth knowing what it does on your machine:

- **No network.** `check`, `validate`, `render`, `diff`, `schema` and `view` never contact any server, and nothing
  is downloaded at run time.
- **`tsverify check` reads your code; it does not run it.** It parses and type-checks your TypeScript with your
  project's own TypeScript 7 compiler. That compiler is a native program from your `node_modules`
  (`@typescript/typescript-<platform>`, installed with `typescript`). tsverify starts it as a child process for each
  project it reads, talks to it over a pipe, and ends it before `check` finishes, including when the check fails.
- **`tsverify test` runs your code.** It generates tests into `.tsverify/generated/` and runs them with your
  project's vitest. They import and execute your project's modules, with storage and side-effect clients replaced
  by in-memory fakes. Run it only on code you would run your own tests on.
- **`tsverify diff`** runs your local `git` to read the base version of each spec. The ref is resolved to a
  commit before use, and no shell is involved.
- **`tsverify view`** serves a read-only page on `127.0.0.1` only; other addresses are refused. It answers only
  requests addressed to a loopback name (which blocks DNS rebinding), serves `GET`/`HEAD` only, and sends a strict
  Content-Security-Policy. To view it from another machine, forward the port over SSH (see
  [docs/viewer.md](docs/viewer.md)).
- **Behavior files are data.** `*.behavior.yaml` files are parsed and validated, never evaluated. `impl` paths
  only point the analysis at your code.
