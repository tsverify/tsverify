# Reviewing an agent PR with a behavior diff

For people reviewing a pull request in which an agent changed code **and** a `*.behavior.yaml` spec. The
behavior diff (`tsverify diff --base <base>`, usually posted as a PR comment) shows what changed in the specs. This
list is what to look for in it. Background: [authoring guide](../authoring-guide.md).

**The question to ask:** did the intended behavior change, or did the spec move to meet the code? Only the first is
legitimate. The PR description must say *why* for every spec change.

## 1. Red flags: a spec that got weaker

Each of these can hide a bug that `tsverify check` was reporting. Accept one only with a stated business reason.

- [ ] **`atomic` removed**: `atomic: yes → no` in the diff table, and `⚠ non-atomic` on the edge. This is the
      classic way to silence a `non-atomic` finding, and it reopens the race.
- [ ] **`from` widened**: an extra from-state, or `"*"`. It silences `from-state-mismatch`.
- [ ] **A guard removed** from `requires` (on a transition or an actor), or an actor's `trust` raised
      (`untrusted` → `authenticated`/`internal`). The first silences `guard-not-dominating`, the second
      `untrusted-guarded`.
- [ ] **An effect removed or relaxed**: `exactly-once` → `at-least-once`/`idempotent`, or the effect deleted.
      It silences `effect-multiplicity`, `missing-effect` and double-charge rules.
- [ ] **`idempotent: true` removed** from a webhook or queue transition, or the actor's trust changed to avoid
      `webhook-idempotent`.
- [ ] **A rule removed or loosened** (`<= 1` → `<= 2`, `never` turned into a narrower expression).
- [ ] **`enforced: true` removed.** It takes the spec out of the blocking CI run.
- [ ] **A binding repointed**: a guard bound to a different (weaker) function, `impl` pointed at another function,
      an effect mapped to another call path.
- [ ] **A transition added just to absorb an `undeclared-transition`** (B1 "reopen" style): is that state change
      really allowed, and by that actor?

## 2. Things the diff doesn't show

- [ ] **New `unanalyzable` warnings** in the `tsverify check` output or SARIF. They don't fail the run, and they mean
      that part of the code is unchecked. Watch for code reshaped so that `tsverify` can't see it: a state written
      through a variable, a status check moved into `.includes`, a client injected instead of imported. Each one
      should be fixed or explained.
- [ ] **`fixtures` and `summary`** are not part of the behavior diff. Read the raw file diff.
- [ ] **A moved or renamed spec** shows up as one behavior removed and one added. Compare them by hand.
- [ ] **`not-generated`** items from `tsverify test`: is a transition that used to be tested no longer tested?
- [ ] **Code-only changes to a transition's path** (a new external call, a guard moved after an early return)
      show up in `tsverify check`, not in `tsverify diff`. Make sure CI ran `tsverify check` on the head commit.

## 3. Things that should be there

- [ ] Spec and code change in the same PR, and the spec change comes with the reason.
- [ ] New transitions have `impl`, guards for every `untrusted` actor, the right effects, and `atomic: true` when
      they check state.
- [ ] New states: either `terminal` or with a way out, and reachable from `initial`.
- [ ] `tsverify check` exits 0, or the PR lists every remaining finding with a reason. `tsverify test` replays
      (`replay-confirmed`) are fixed, not skipped.
- [ ] The Mermaid diagram in the diff comment matches the change you expect: added edges are marked `+`, removed
      ones `−`, changed ones `~`.

## 4. When in doubt

Ask the agent to restore the stricter spec and fix the code instead. If the code can't meet the spec, the PR has
found a real design question. That decision belongs to a person, not to the agent.
