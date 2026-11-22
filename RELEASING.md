# Releasing

Two packages are published to npm: **`@tsverify/cli`** (the `tsverify` command, one esbuild bundle) and
**`@tsverify/runtime`** (imported by generated tests). Every other workspace package is `private` and bundled
into the CLI. All workspace packages share one version.

## Once

- Claim the `tsverify` npm org and GitHub org ([idea/7](idea/7.%20name-and-license.md)).
- Create an npm automation token with publish rights on `@tsverify` and store it as the `NPM_TOKEN` repository
  secret.

## Each release

1. **Version.** Set the new version in every `package.json` under `packages/`, `examples/` and `spikes/` (they
   stay equal), and regenerate the SARIF goldens, which carry the tool version:
   `pnpm vitest run packages/cli/test/e2e --update` (review the diff).
2. **Changelog.** Move the `[Unreleased]` entries of `CHANGELOG.md` under the new version and date it.
3. **Check locally.**
   ```sh
   pnpm run ci
   pnpm smoke:pack          # packs both packages, npm-installs them into a copy of examples/orders-app, runs the CLI
   ```
   To inspect what would be published, run `pnpm pack` in `packages/cli` or `packages/runtime` and look inside the
   tarball. `prepack` builds `dist/` and copies `README.md`, `LICENSE`, `NOTICE` and `CHANGELOG.md` into the
   package; the copies are gitignored. (`npm pack --dry-run` lists nearly the same files, but it ignores
   `publishConfig`, so it also packs the dev launcher `bin/tsverify.js` and keeps `workspace:*` ranges.)
4. **Tag and push.** Commit, then `git tag v<version>` and `git push origin main v<version>`.
5. **CI publishes.** [`.github/workflows/release.yml`](.github/workflows/release.yml) runs on `v*` tags: it checks
   that the tag matches the package versions, runs `pnpm run ci` and `pnpm smoke:pack`, then
   `pnpm --filter @tsverify/runtime --filter @tsverify/cli publish --access public`. Prerelease versions
   (`-alpha.0`, …) go to the `next` dist-tag, others to `latest`.
6. **Verify.** `npm view @tsverify/cli` and, in an empty project,
   `npm install --save-dev @tsverify/cli && npx tsverify --version`.

## How the packages are built

- **`@tsverify/cli`**: `packages/cli/scripts/build.ts` (esbuild) writes `dist/tsverify.js`, which bundles every
  `@tsverify/*` package except the runtime and leaves third-party packages external; the build fails if the bundle
  imports a package that is not in the CLI's `dependencies`. It also prebuilds the viewer app into `dist/viewer/`
  and copies `behavior.schema.json` into the package root.
- **`@tsverify/runtime`**: `tsc -p tsconfig.build.json` compiles `src/` to `dist/` (JS + `.d.ts`).
- In development, `exports` and `bin` point at `src/` and the tsx launcher. `publishConfig` swaps them for `dist/`
  when pnpm packs or publishes, so always publish with **pnpm**, not `npm publish`.

## Provenance

npm provenance needs a public source repository. Once this one is public, add `--provenance` to the publish step
and `id-token: write` to the workflow's permissions (both are there as comments).
