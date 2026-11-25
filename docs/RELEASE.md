# Release status

## Done

- Public GitHub repository: https://github.com/EricScottLin/dsh-plugin-repeat-tool-guard
- Topic `dsh-plugin` added (required by the market).
- GitHub Release `v1.0.0` with the prebuilt npm tarball as an asset:
  https://github.com/EricScottLin/dsh-plugin-repeat-tool-guard/releases/tag/v1.0.0
- `npm test`: 10/10 pass; `npm pack --dry-run`: 9 files, 12.3 kB.

## Verified install paths

- GitHub source install tested in a scratch project:
  `pnpm add github:EricScottLin/dsh-plugin-repeat-tool-guard` → 1.0.0,
  `import('dsh-plugin-repeat-tool-guard')` → `repeat-tool-guard` / `apply` function.
- Release tarball downloaded and inspected: 9 files, including `index.js`,
  `cordis.patch.yml`, `package.json`, both READMEs, `CHANGELOG.md`, `LICENSE`,
  `docs/POST.md`, `docs/VERIFY.md`.

## Blocked: npm publish

This machine has no npm credentials (`npm whoami` → ENEEDAUTH), so the package
is not on the public npm registry yet. Publishing requires the account owner:

```sh
cd /data/dsh/workspace/dsh/dsh-plugin-repeat-tool-guard
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```

After that, the market index (which only indexes npm-published plugins) can see
it. Until then, the GitHub Release tarball is the install path.

## Market submission

The awesome-dsh-plugin list requires the repository to be **at least 1 day old**
(automatic CI check). Do not open the PR before 2026-11-26.

Entry file to add to `awesome-dsh-plugin/awesome-dsh-plugin`:

`data/plugins/EricScottLin__dsh-plugin-repeat-tool-guard.yml`

Copy the contents of `market/awesome-dsh-plugin.yml`. Open a PR that adds only
that file. If npm publish is still blocked, keep the `tarball:` field; otherwise
remove it (npm is the preferred install path).

## Warning post

Draft: `docs/POST.md`. Venue suggestion: a DeepSeek Harness GitHub Discussion
(“Show and tell”); do not post without the account owner's approval.
