# Releases

A release is cut by the production promote itself. When `deploy-production`
succeeds, its `release` job calls `.github/workflows/release.yml` with the exact
deployed SHA. `ci/release-on-promote.cjs` then tags that commit `vX.Y.Z` and
publishes a GitHub Release whose notes list the Conventional Commit subjects
(squash-merged PR titles) since the previous `vX.Y.Z` tag. Never tag or release
by hand.

There is no release PR, so there is nothing to regenerate, re-check, review or
freeze `main` for: the version and notes are derived from commits that already
passed CI and review on `main`. The release-please release PR it replaces went
stale on every merge and needed a freeze, dispatched checks and a separate
review to land.

## Cutting a release

Nothing to do by hand: a successful `deploy-production` promote is the cut. The
cutover promote cuts `v1.0.0` (see `release-as` below). The release vehicle is
the promoted commit itself. Every commit on `main` already has exact-head green
required checks and a Paperclip Review 5/5 (rulesets). The promote gate
(`ci/production-deploy-gate.mjs`) requires a green main `ci` on that exact SHA,
plus staging evidence under auto-approve. There is no release PR and no
release freeze.

## Versions and notes

- Bump rules and note sections are read from `release-please-config.json`
  (`bump-minor-pre-major`, `bump-patch-for-minor-pre-major`,
  `changelog-sections`), so versions continue the existing tag line.
- `release-as` in `release-please-config.json` forces the next version while it
  is above the previous tag. It is set to `1.0.0`, so the production cutover
  promote (the first production deploy) cuts `v1.0.0`; once `v1.0.0` exists it
  is ignored and normal bumps resume (remove it in any later PR).
- Before `1.0.0`: `feat!` / `BREAKING CHANGE` and `feat` bump the minor version;
  everything else bumps the patch version. From `1.0.0` onward: breaking bumps
  major, `feat` bumps minor, anything else bumps patch.
- Every promote of new commits gets a tag, even one with only hidden types
  (`chore`, `ci`, ...); its notes say there are no user-facing changes.
- Promoting a commit that already has a tag reuses that tag and only repairs a
  missing GitHub Release. Promoting a commit older than the newest release (a
  rollback) creates no tag.
- `CHANGELOG.md` keeps the history up to `v0.4.0`; later notes live on the
  GitHub Releases page.

## Repairing a missed release

If a promote deployed but its `release` job failed, dispatch the workflow for
the deployed SHA (it is idempotent):

```sh
gh workflow run release.yml --ref main -f sha=<deployed 40-hex SHA>
```

`-f dry_run=true` prints the version and notes without publishing.

`ci/release-on-promote.selftest.cjs` (run by `test/release-workflow.test.ts`)
pins the bump rules, note rendering, the rollback guard and the refusal to tag
a commit that is not on `main`.
