# Releases

A release is cut by the production promote itself. When `deploy-production`
succeeds, its `release` job calls `.github/workflows/release.yml` with the exact
deployed SHA. `ci/release-request.cjs` proves that promotion from its receipt.
Then the shared CalVer releaser (`TogetherWeOwn/.github` `actions/calver`,
policy `production-promotion`) tags that commit `vYYYY.MDD.P` and publishes a
GitHub Release, marked Latest. Its notes list the Conventional Commit subjects
(squash-merged PR titles) since the previous stable tag. Never tag or release
by hand.

There is no release PR and no release commit, so there is nothing to
regenerate, re-check, review or freeze `main` for. The version comes from the
tag history and the notes come from commits that already passed CI and review
on `main`.

## Cutting a release

Nothing to do by hand: a successful `deploy-production` promote is the cut. The
release vehicle is the promoted commit itself. Every commit on `main` already
has exact-head green required checks, including `CodeRabbit` and `Devin Review`
(rulesets). The promote gate (`ci/production-deploy-gate.mjs`) requires a green
main `ci` on that exact SHA, plus staging evidence under auto-approve. The tag
is written only after the deploy job's promotion and identity-aware smoke
succeed.

## Versions and notes

- Versions are calendar versions in the upstream Paperclip syntax:
  `vYYYY.MDD.P`. The month has no leading zero and the day has two digits, so
  2026-11-01 is `v2026.1101.0` and 2026-03-05 is `v2026.305.0`.
- The date is the UTC date of the promote. `P` starts at 0 and counts the
  stable releases already tagged that day, read from the tag history when the
  release is planned.
- `package.json` keeps its own version; the tag is the release version.
- Before the switch the repository used SemVer, up to `v1.21.2`. Those tags are
  never moved or deleted. CalVer versions sort above them (major `2026` > `1`),
  and the first CalVer release ranges its notes from `v1.21.2`.
- Note sections are the `changelog-sections` entries in
  `release-please-config.json` (that is all the file holds now): `perf` and
  `revert` go under Changed, `feat` under Added, and `fix` and `security` under
  Fixed. `BREAKING CHANGE` footers and `!` headers are listed first. Hidden
  types (`chore`, `ci`, ...) are left out; a promote with only hidden types
  still gets a tag, and its notes say there are no user-facing changes.
- Promoting a commit that already has a stable tag (from an earlier promote,
  legacy or CalVer) skips green, with no new tag. Promoting a commit older than
  the newest stable release (a rollback) also skips green, so Latest never
  moves backwards.
- There are no canary tags for staging deploys.
- `CHANGELOG.md` is frozen history up to `v0.4.0`; later notes live on the
  GitHub Releases page.

## Promotion evidence

The release job proves the promotion twice before any write:

1. `ci/release-promotion-proof.cjs` (called by `ci/release-request.cjs`) checks:
   - the repository and head repository are this one, the workflow is the
     active `.github/workflows/deploy-production.yml`, the producer runs on
     `main` on local `origin/main`, and the trigger is `workflow_dispatch`,
     `workflow_run` or `schedule`;
   - the exact producing run **and attempt** has a successful
     `deploy-production` job whose gradual-promotion, identity-aware smoke,
     receipt-write and receipt-upload steps succeeded in that order;
   - exactly one unexpired `production-promotion-<sha>-<run_id>-<run_attempt>`
     artifact with a digest belongs to that run. Its only member is the bounded
     `promotion.json` receipt (schema 1: `repository`, `workflow`,
     `job: deploy-production`, exact `sha`, UUID `promoted_version_id`, string
     `run_id` / `run_attempt`). The selected SHA comes from preflight and can
     differ from the producer workflow's checkout SHA.
2. The shared releaser re-reads that run attempt, the named `deploy-production`
   job and the artifact (ID, name, digest, producer) from GitHub. The artifact
   name must carry the deployed SHA, and that SHA must be on `main` and in the
   run's history.

The production job writes and uploads the receipt **only after** its
identity-aware smoke succeeds. `PROMOTION_RUN_ID` / `PROMOTION_RUN_ATTEMPT` are
untrusted selectors, never assertions of success. Supply both or neither.
Without them, discovery reads one page of at most 100 main runs of the canonical
workflow and at most 20 candidates with a receipt for this SHA. An exhausted
list, unreadable or malformed evidence, or an ambiguous artifact refuses. API
responses are capped at 1 MiB, archives at 64 KiB, receipts at 4 KiB, each
subprocess at 15 seconds and the proof at two minutes. No second credential is
tried.

The producing run may be globally **failed** because its release job failed, or
still **in progress** inside its release call. Both still count: the successful
deploy job and its receipt are the evidence, not the run's overall conclusion.

## Repairing a missed release

The release job first repairs itself: a failed CalVer plan or publish is
retried once, after a short wait, inside the same job attempt, because the
releaser makes each GitHub API call only once and a transient fetch failure
must not leave a deployed commit untagged. The publish retry runs in repair
mode for its own frozen plan (never on a dry run), so a first attempt that
created the tag but died before its Release still completes that Release.

If a promote deployed but its `release` job still failed, dispatch the release
workflow on `main` for the **exact deployed SHA** and the producing run and
attempt:

```sh
gh workflow run release.yml --ref main -f sha=<deployed-40-hex-SHA> \
  -f promotion_run_id=<production-run-id> -f promotion_run_attempt=<attempt>
```

One production run attempt is one release operation
(`production-<run_id>-<attempt>`). The plan is frozen into the tag's
annotation, so once the tag exists a dispatch for the same attempt recovers
that plan, including its date, even after midnight. If the tag exists but its
GitHub Release does not, add `-f repair=true`; repair never retags. If the
failed run never created the tag, nothing was frozen: the dispatch plans again
with the current UTC date and counter. A historical repair never moves Latest
backwards.

Do not use **Re-run failed jobs** to repair publication: it starts a new
attempt without repeating the deploy, and that attempt has no receipt, so it
refuses. Dispatch `release.yml` as above with the original attempt instead.
**Re-run all jobs** is not release repair: it may redeploy production and must
follow the normal deployment gates.

Receipts are kept for **30 days**. Runs from before the CalVer switch name
their receipt without the SHA, so they cannot be repaired through this
workflow. Expired, deleted or missing proof refuses; the workflow never
redeploys, rolls back or invents proof.

`-f dry_run=true` runs every check above and prints the planned version without
writing anything (the releaser's client refuses every non-GET request). It is
not authorization for a later real run, which checks everything again.

The Actions token gets job-local `actions: read` and `contents: write` in the
release job, and the caller grants no more. Workflow-wide `permissions: {}`
stays in place.

## Diagnosing ref authorization without publishing a release

A `contents: write` Actions token can still receive HTTP 403 when tagging an older
commit whose workflow files differ from the invocation/default branch. The exact
comparison base is not a documented guarantee. A release dry run cannot test
this: it refuses every non-GET request. Do not use a production tag as a probe or
expand token permissions to diagnose it.

`ci-ref-auth-probe.yml` is a dispatch-only diagnostic. It uses only job-local
`contents: write`, no checkout, environment, repository variables or additional
secrets. It validates a full lowercase SHA as an ancestor of a captured main tip,
then mirrors the publisher's annotated tag-object / tag-ref API sequence under
`refs/tags/ci-probe/ref-auth/<run-id>-<attempt>-<arm>`. These refs cannot parse as
CalVer. It never calls the Releases API, changes Latest or dispatches deployment.
The API status and response body go to the Actions log (not request headers), and
the summary records target, captured main, invocation SHA/ref and cleanup.

The workflow must first land through normal review, Security, exact-head Actions
and Release Manager merge gates. Before each dispatch, inspect the workflows at
both the invocation and target commits for tag/create/release triggers that could
turn a diagnostic ref into a deployment. Keep the run URLs and exact SHAs as
evidence. Do not introduce an artificial main change just to run the experiment.

Let M1 contain the probe and M2 be a later main commit with different workflow
files. Run these arms in order, stopping if a control fails or cleanup is not
confirmed:

| Arm | Dispatch ref | Target | Intended evidence |
| --- | --- | --- | --- |
| 1 | main at M2 | M2 | Positive control: tag ref returns 201 |
| 2 | main at M2 | M1 | Older-workflow target: capture the response, including a possible 403 |
| 3 | temporary branch at M1 | M1 | Test whether matching the run head permits the same older target |

For example, with the exact full target SHA substituted:

```sh
gh workflow run ci-ref-auth-probe.yml --ref main -f target_sha=<M2-SHA> -f arm=1
```

Arm 3 requires an authorized temporary branch at M1; creating that branch may
itself fail for the same workflow-permission reason. Record the actual creating
identity. A denied ref write is an access prerequisite, not permission to try a
broader credential. Remove the temporary branch after the experiment.

The `always()` cleanup step reads the exact diagnostic ref, refuses to delete
anything not pointing to this attempt's annotated tag object, deletes it when
present, then independently confirms HTTP 404. A refused POST remains a failed
job even when cleanup succeeds; read the creation step, not just the run badge.
A cleanup error or a force-terminated runner is not proof of absence: inspect and
remove only the recorded owned diagnostic ref before continuing. Do not delete
release tags. Unreferenced annotated tag objects need no further operation.

Arm 3 returning 201 after arm 1 succeeds and arm 2 returns 403 supports a run-head
recovery. A 403 in arm 3 refuses that proposed route, but its body and controls
must still be inspected for other restrictions. Neither outcome authorizes
production publication. Any recovery retains the original successful production
producer run/attempt, revalidated receipt, normal release-only workflow and fresh
exact-SHA Release Manager acceptance. Do not rerun production, manufacture proof,
backdate an unfrozen plan, reuse an admin App or broaden credentials. Durable
publisher changes depend on the observed result and require their own review.

## Tests

- `test/ref-auth-probe.test.ts`: executes the workflow's inline scripts against
  fake GitHub responses; validates namespace, ancestry, 403 evidence, no retry,
  ref ownership and fail-closed cleanup. This is fixture evidence, not a live
  ref-write permission test.

- `test/release-workflow.test.ts`: the release workflow shape, the shared
  releaser pin and the plan request (`ci/release-request.cjs`).
- `ci/release-promotion-proof.acceptance.cjs`, wired through
  `test/release-promotion-proof.test.ts`: trusted and untrusted evidence, exact
  SHA and attempt binding, the workflow's receipt producer, failed-publication
  recovery, and no request on refusal. It uses fake `gh` and throwaway git
  repositories.
- Version allocation, tagging, notes, Latest, dry run, repair and the skips are
  covered by the shared releaser's own offline suite in `TogetherWeOwn/.github`
  (`ci/calver-acceptance.test.mjs`).
