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

## npm

Published `dsh-plugin-repeat-tool-guard@1.0.0` to the public registry on
2026-11-27. npm's staged publishing created a `0.0.0-stage` placeholder first;
`latest` now points at `1.0.0`, and the placeholder is deprecated.

```sh
dsh plugin --profile web add dsh-plugin-repeat-tool-guard
```

The market index can now index the package once the catalog is rebuilt.

## Market submission

The awesome-dsh-plugin list requires the repository to be **at least 1 day old**
(automatic CI check). The repo was created 2026-11-25, so it is eligible now.

Entry file to add to `awesome-dsh-plugin/awesome-dsh-plugin`:

`data/plugins/EricScottLin__dsh-plugin-repeat-tool-guard.yml`

Copy the contents of `market/awesome-dsh-plugin.yml`. Open a PR that adds only
that file. npm is published, so the entry has no `tarball:` field.

## Warning post

Drafts: `docs/POST.md` (English) and `docs/POST.zh.md` (Chinese). Venue
suggestion: a DeepSeek Harness GitHub Discussion (“Show and tell”); do not
post without the account owner's approval.

## Market PR status

Branch `add-dsh-plugin-repeat-tool-guard` has been pushed to the fork
`EricScottLin/awesome-dsh-plugin` with the entry file:

`data/plugins/EricScottLin__dsh-plugin-repeat-tool-guard.yml`

`gh pr create` was refused by the current fine-grained PAT:

```
GraphQL: Resource not accessible by personal access token (createPullRequest)
```

Open the PR from the fork in the browser (one click, uses the owner's web
session):

https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...EricScottLin:add-dsh-plugin-repeat-tool-guard?expand=1

The entry has no `tarball:` field because npm 1.0.0 is published.

## npm

`dsh-plugin-repeat-tool-guard@1.0.0` is public; `npm install` + `import` tested.
The `0.0.0-stage` placeholder created by npm staged publishing is deprecated.
