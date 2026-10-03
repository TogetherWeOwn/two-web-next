# Releases

`CHANGELOG.md`, the `vX.Y.Z` tag and the GitHub Release come from
[release-please](https://github.com/googleapis/release-please) via
`.github/workflows/release.yml` (config: `release-please-config.json` +
`.release-please-manifest.json`, release-type `node`). Never tag or release by
hand. Versioning and changelog categories are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#releases).

## Release triggers

`release.yml` treats its events differently (TOG-13034, a port of the
two-bot-next fix in TOG-12931). It used to regenerate the release PR on every
push to `main`: the PR head was rewritten about a minute after each merge and a
full `ci` + `pr-gates` started on the new head. With roughly ten merges an hour
the PR never held one head long enough to be green and merged, and every merge
spent a run on a head nobody could use. Now:

| Event | Publishes a merged release PR | Regenerates the PR | Dispatches `ci` / `pr-gates` |
| --- | --- | --- | --- |
| `push` to `main` | yes | **no** (`skip-github-pull-request`) | **no** |
| `workflow_dispatch` | yes | yes | yes |
| `schedule` (Mondays 04:23 UTC) | yes | yes | yes |

The tag and release are published by the `push` run for the release PR's merge
commit, exactly as before: the publication path and the job permissions did not
change, and `skip-github-release` is never set. A missed publication is
recovered by the next run of any kind. `pr-lint`, `gitleaks` and `ci` stay
required on the release PR; the dispatched runs are still the only way they
start on a `GITHUB_TOKEN`-created PR (see the header of `release.yml`).

`test/release-workflow.test.ts` pins this: it fails if a push can regenerate
the PR or dispatch checks, if publication is ever skipped, or if the schedule
disappears.

## Cutting a release

With no push regeneration the open release PR lags `main` by design. Cut a
release with a short freeze: release-please drops commits that land between the
PR's generation snapshot and its merge commit (they ship in the tag but appear
in neither release's notes).

1. **Announce the freeze.** The Director (or the COO) posts on the release card
   that nothing merges to `main` until the freeze is lifted, and confirms no
   merge is in flight.
2. **Dispatch regeneration.** `gh workflow run release.yml --ref main`, then wait
   for the run. It regenerates the PR from the current `main` and dispatches
   `ci.yml` and `pr-gates.yml` on the new head.
3. **Confirm the PR is fresh.** The release branch must not be behind `main`:
   ```sh
   gh api "repos/TogetherWeOwn/two-web-next/compare/main...release-please--branches--main--components--two-web-next" --jq .behind_by
   ```
   `0` means the PR was generated from today's `main`. Anything else (or no open
   release PR) means `main` moved after the snapshot: do not merge, dispatch
   again.
4. **Exact-head green and review.** `ci` (`check`), `pr-lint` and `gitleaks` are
   green on the PR's current head SHA, and the Code Reviewer approved that same
   SHA. A re-push, including a new regeneration, restarts both.
5. **Reviewer merges.** The approving reviewer squash-merges with
   `expectedHeadSha` set to the reviewed head. The merge's `push` run publishes
   the tag and GitHub Release; verify the new `vX.Y.Z` release and the
   `autorelease: tagged` label on the PR.
6. **Lift the freeze** once publication is verified. The next release PR appears
   at the next dispatch or Monday run.

The freeze is the exception path for the cut, not a standing hold: outside steps
1-6 `main` merges freely and nothing rewrites the release PR.
