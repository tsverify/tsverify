## Behavior specs (tsverify)

Stateful behavior in this repo (an entity's status field: its transitions, guards, side effects and races) is
specified in `*.behavior.yaml` files and verified by `tsverify`. How to write them: `docs/tsverify/authoring-guide.md`.

**Workflow: spec first, then code, then `tsverify check`.**

1. Before changing code that writes a state field, adds or moves a guard, or adds an external call (payments,
   email, queues) on a state change: update the spec, or write one (one per entity). Run `tsverify check --spec-only`
   until it exits 0.
2. Write the code.
3. Run `tsverify check` until it exits 0. If the spec has `fixtures`, run `tsverify test` too.

**Rules**

- Keep each spec next to the code it describes (`src/orders/order.behavior.yaml` beside `order.ts`). Paths in a
  spec are relative to the nearest `tsconfig.json`.
- Never edit a spec only to silence a finding. A finding means the code and the intended behavior disagree, so fix
  the code. Don't drop `atomic`, guards, effects or rules, and don't widen `from`.
- Change a spec only when the intended behavior changes, and explain each change in the PR description.
  Reviewers see it in `tsverify diff --base origin/main`.
- `unanalyzable` warnings mean the code is unchecked. Restructure the code (guide §7.5) or explain each one in the
  PR.
- Use `--format json` when you parse the output.

**Exit codes:** `0` pass · `1` violations: fix them, usually in the code · `2` invalid spec, broken link or
bad usage: fix the input · `3` internal error in tsverify: report it, don't work around it.
