# `@tsv/render` tests

Golden outputs live in `__golden__/` and are compared with vitest's `toMatchFileSnapshot`.
After an intentional output change, regenerate them with:

```sh
pnpm vitest run packages/render --update
```

(Not `-u packages/render`: `-u` then takes the path as its value and every snapshot in the repo is
updated.)

Review the regenerated files in the diff before committing.

## Eyeballing the Mermaid goldens

The `.mmd` files are plain Mermaid source. To see them rendered:

- **mermaid.live**: paste the file's contents into <https://mermaid.live>. It renders as you type
  and reports parse errors with line numbers.
- **GitHub**: open the `.mmd` file in the GitHub file view, which renders Mermaid files. In an
  issue, PR comment or Markdown file, wrap the contents in a ` ```mermaid ` fenced block. That is
  the same form the `tsv diff` PR comment uses.
- **VS Code**: any Mermaid preview extension can open `.mmd` files directly.

Things to check by eye: state order and edge order are stable, `[*]` start and end markers are
present, highlighted states are filled and highlighted edges start with `▶`, and escaped labels
(`#58;` for `:`, `#35;` for `#`, and so on) show the original characters once rendered.

The `*-diff.mmd` goldens are `flowchart LR` diagrams (`toMermaidDiff`), not state diagrams: only
flowcharts can style edges. Check that added edges are thick (`==>`) and labelled `+`, removed
ones dotted (`-.->`) and labelled `−`, changed ones labelled `~`, and that the `linkStyle` colors
land on those same edges. The `*-diff.md` goldens are whole PR comments; paste one into a GitHub
comment preview to see it as reviewers will.
