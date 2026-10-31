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
required checks, including `CodeRabbit` and `Devin Review` (rulesets). The promote gate
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
- Note sections are the `changelog-sections` entries: `perf` and `revert` go
  under Changed, `feat` under Added, and `fix` and `security` under Fixed.
  `security` is a patch bump, like `fix`.
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

If a promote deployed but its downstream `release` job failed, dispatch the
release workflow on `main` for the **exact deployed SHA**, with the producing
production run and attempt as optional selectors:

```sh
gh workflow run release.yml --ref main -f sha=<deployed-40-hex-SHA> \
  -f promotion_run_id=<production-run-id> -f promotion_run_attempt=<attempt>
```

A main ancestor is not proof of promotion: newer unpromoted main B cannot be
published using deployed A's evidence. A **new tag** requires all of:

- GitHub-authenticated repository and head-repository identities matching this
  repository, the active canonical `.github/workflows/deploy-production.yml`
  workflow ID/path, a main-branch producer on local `origin/main`, and a supported
  production trigger (`workflow_dispatch`, `workflow_run` or `schedule`).
- The exact producing run **and attempt**, a completed successful
  `deploy-production` job, and successful ordered gradual-promotion,
  identity-aware post-promotion smoke, receipt-write and receipt-upload steps.
  Workflow display names or a globally green conclusion alone do not suffice.
- Exactly one unexpired `production-promotion-<run_id>-<run_attempt>` artifact
  belonging to that repository/run/main head. Its only member is the bounded
  `promotion.json` receipt, never an extracted archive tree. Schema 1 binds
  `repository`, `workflow: .github/workflows/deploy-production.yml`,
  `job: deploy-production`, exact selected `sha`, UUID `promoted_version_id`, and
  string `run_id` / `run_attempt`. The selected SHA comes from preflight and can
  differ from the producer workflow's checkout SHA.

The production job records/uploads this receipt **only after** its existing
identity-aware smoke succeeds. Its ordinary reusable release call passes the
producing run/attempt; manual selectors become `PROMOTION_RUN_ID` and
`PROMOTION_RUN_ATTEMPT`. These are untrusted hints, never caller assertions of
success. Supply both or neither. Without hints, discovery reads the canonical
workflow's main runs; it never falls back to publishing unchecked. Discovery is
bounded to one complete page of at most 100 runs and 20 eligible candidates;
selected-run jobs and artifacts each require a complete page of at most 100.
An exhausted list, unreadable/malformed evidence, an ambiguous artifact or an
inconclusive candidate refuses. Select the exact known run/attempt to avoid
exhausted discovery; it must pass the same checks. API responses are capped at
1 MiB, archives at 64 KiB, receipts at 4 KiB, each subprocess at 15 seconds and
the proof operation at two minutes. No second credential is tried.

The producer workflow may be globally **failed** because downstream publication
failed, or still **in progress** inside its release call. Repair still works:
only its completed successful deploy job and post-smoke proof authorize the new
tag, not global workflow success. Failed/skipped/in-progress smoke never does.

Do not use **Re-run failed jobs** to repair publication: it increments the current
`github.run_attempt` without repeating the successful deploy, while that deploy's
job, artifact and receipt remain bound to the original producing attempt. The
ordinary release caller supplies the current attempt, so that rerun deliberately
refuses new-tag proof rather than combining attempts. Instead, dispatch
`release.yml` on `main` using the command above with the exact deployed SHA and
original producing run/attempt. **Re-run all jobs** is not release repair: it may
redeploy production and must follow the independent deployment gates.

Receipts are retained for **30 days** (subject to repository retention limits).
Runs from before this protocol have no receipt. Expired, deleted or missing proof
refuses new-tag repair; the workflow never redeploys, rolls back or manufactures
replacement proof. Retry the same SHA/run/attempt only after an API outage is
resolved or the correct retained evidence is identified. If no valid evidence
exists, stop; any future deployment follows the normal independent deployment
gates, not an automatic release-repair workaround.

Already-tagged missing-release repair reuses that tag without demanding new-tag
proof. Historical repairs explicitly keep `--latest=false`; an existing release
is a no-op and rollback promotes create no new tag. Before creating anything,
release lookup still treats **only HTTP 404** as absence. An outage, rate limit,
auth failure or no network is inconclusive and fails closed. A partial
publication that created the tag but not its release retries the same tag/SHA,
never an extra version bump.

`-f dry_run=true` prints version/notes without publishing or checking promotion
proof. It is a nonmutating preview, **not authorization** for a later real run;
the real run must independently verify evidence. Release repair does not change
production traffic. The ephemeral Actions token gains only job-local
`actions: read` in the reusable publisher and its caller; workflow-wide
`permissions: {}` and scoped `contents: write` stay intact. Revert those two read
declarations through normal review to revoke this capability; missing access
then refuses new-tag publication, never bypasses proof.

`ci/release-on-promote.selftest.cjs` and
`ci/release-on-promote-latest.acceptance.cjs` pin versioning, reuse, historical
Latest and release-lookup failure behavior. The independently paired
`ci/release-promotion-proof.acceptance.cjs`, wired through
`test/release-promotion-proof.test.ts`, pins trusted/untrusted evidence, exact
SHA/attempt binding, workflow receipt production, failed-publication recovery,
dry-run and zero publication on refusal. All publication tests use fake `gh`
and throwaway git repositories; no real tags/releases or deployments.
