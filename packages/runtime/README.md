# @tsverify/runtime

The runtime library of [tsverify](https://github.com/tsverify/tsverify), which verifies TypeScript code against
`*.behavior.yaml` state-machine specs.

You don't call it yourself. The tests that `tsverify test` generates (under `.tsverify/generated/`) import it: it
replays a model-checker counterexample against your real code, with a scheduler that gates every call on your
clients in the order the counterexample dictates, plus in-memory fakes for stores, effect clients and the Prisma
client.

- **`tsverify test` needs nothing else.** `@tsverify/cli` depends on this package and points the generated tests at
  its own copy.
- **Running the generated tests with your own vitest** (e.g. as part of `vitest run`) needs `@tsverify/runtime` and
  `vitest` as devDependencies of your project:

  ```sh
  npm install --save-dev @tsverify/runtime vitest
  ```

  Use the same version of `@tsverify/runtime` as `@tsverify/cli`.

- Zero dependencies. Node.js 22.12 or later.

Semantics, API and the shape of a generated test:
[`DESIGN.md`](https://github.com/tsverify/tsverify/blob/main/packages/runtime/DESIGN.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 The tsverify Authors.
