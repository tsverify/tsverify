# Agent kit

Files that teach a coding agent to work with `tsverify` in your repository:

| File | For | What it is |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | the agent | A short snippet (about 250 words) to paste into the agent's context file: spec first, then code, then `tsverify check`; never weaken a spec to pass; exit codes |
| [`../authoring-guide.md`](../authoring-guide.md) | the agent, on demand | The full guide the snippet points to: how to write a spec for new or existing code, and how to read each finding |
| [`review-checklist.md`](review-checklist.md) | human reviewers | What to check in an agent's PR that changes behavior |

## Install

1. **Vendor the guide.** Copy `docs/authoring-guide.md` to `docs/tsverify/authoring-guide.md` in your repository. The
   snippet refers to that path, so the agent can open the guide without network access. If you put it
   somewhere else, change the path in the snippet. The guide links to `behavior-format.md` and `workflows.md`
   (copy them next to it), and to examples that exist only in the `tsverify` repository.
2. **Paste the snippet** into the context file your agent reads. Paste it as a section; don't replace the file:

   | Agent | File |
   |---|---|
   | Codex, Jules, Amp and other agents that read `AGENTS.md` | `AGENTS.md` at the repository root (or in a subdirectory, for that subtree only) |
   | Claude Code | `CLAUDE.md` at the repository root. Or keep the text in `AGENTS.md` and add a line `@AGENTS.md` to `CLAUDE.md` |
   | Cursor | `.cursor/rules/tsverify.mdc`, with front matter `description: Behavior specs (tsverify)` and `globs: **/*.behavior.yaml, src/**/*.ts`, or `alwaysApply: true` |
   | GitHub Copilot | `.github/copilot-instructions.md` |
   | Windsurf | `.windsurf/rules/tsverify.md` |
   | Gemini CLI | `GEMINI.md` |
   | Anything else | Wherever it reads project instructions. The snippet is plain Markdown with no tool-specific syntax |

3. **Make `tsverify` runnable** where the agent works. `tsverify` is not published yet: until it is, run it from a
   checkout of this repository (`pnpm exec tsverify …`, which keeps the exit codes; `pnpm tsverify …` reports 2 and 3
   as 1), and replace `tsverify` in the snippet with the command you use. Once it is published, a `devDependency`
   plus `npx tsverify` will do.
4. **Optional: editor support for the agent too.** Point `yaml-language-server` at the JSON Schema
   ([guide §9](../authoring-guide.md#9-editor-support-json-schema)), so editor-integrated agents see schema errors
   inline.
5. **Wire CI** ([workflows](../workflows.md)), so that what the agent ran locally is also what blocks the merge.

## Adapting the snippet

- Keep it short. It is read on every turn, and the guide holds the details.
- Narrow the trigger if `tsverify` covers only part of the repository: "Before changing code under `src/orders/` …".
- If the team blocks only on enforced specs, add: "Specs with `enforced: true` block the merge."
- Keep the rule against weakening specs, word for word. It is the one an agent is most tempted to break.
