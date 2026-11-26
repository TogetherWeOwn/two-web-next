# Contributing

## Pull request contract

The same contract applies to humans and AI agents. [AGENTS.md](AGENTS.md) is the short
version.

- Work on a branch and open a PR. Never push to `main`. Name branches
  `type/short-slug`, for example `fix/sudo-window`. Head branches are deleted when
  the PR merges.
- The workspace may hand you a local branch named after a tracker card; keep committing to it, never publish that name, push `git push origin HEAD:refs/heads/<type>/<short-slug>` and open the PR from that ref.
- Squash-merge only. Each PR is one logical change. The squash commit takes the PR
  title and body, so write both for the history on `main`.
- PR title = Conventional Commits header: `type(scope): summary`, at most 100
  characters, no trailing period. Types: `feat`, `fix`, `perf`, `refactor`,
  `test`, `docs`, `build`, `ci`, `chore`, `revert`, `style`, `security`. The scope
  names the area of the code, such as `auth`, `events` or `sync`. Release automation
  reads these headers.
- Use the [PR template](.github/pull_request_template.md), in short, active
  sentences. `pr-lint` warns on a missing or thin Linked Issues or Issue Description
  and fails on missing Verification evidence. Always
  fill in Attestation too. `pr-lint` enforces its declared risk tier from the
  PR-number cutoff below. The other sections
  are optional. See "What fails `pr-lint` today vs what only
  warns" below for the full fail/warn split.
- Link a public GitHub issue with `Closes #123`, or describe the problem in the PR.
  No card reference is required. `docs`, `chore`, `build`, `ci`, `style`, `test` and
  `revert` PRs need no linked issue.
- Search first. Look for an open or recent PR that touches the same area, and link
  what you find.
- Keep references public-safe. Do not put internal card IDs (`TOG-` or `PAP-`
  followed by digits), instance UI links, the internal host, private URLs, tokens or
  secrets in any title, body, commit, comment or branch name. A tracker ID, instance
  UI link or the internal host in the title or body fails `pr-lint`, comments
  included; a card ID in a commit subject warns (first checker,
  `INTERNAL_ID_LEVEL: "warning"`); a branch-name internal ID fails only on a PR
  numbered at or above `HEAD_REF_ERROR_FROM_PR: "627"`, and warns below it; other
  title/body references follow `PR_STANDARDS_MODE`.
- Every PR, including docs-only and draft heads, must not increase the total count of internal card IDs and instance-UI links in tracked files versus its fork point (the merge-base with its base); `pr-lint` fails when that tracked-file ratchet grows, with named lint-fixture exclusions only.
- Each Verification bullet needs a code-formatted command and its observed
  result, or a GitHub Actions run/job URL. List unrun checks in Notes for reviewers.
- Address every review finding, or reply with why it does not apply.
- Credit the contributors whose work you build on.
- Done means merged. Do not leave an orphan PR open: merge it, or close it with a
  comment naming what replaced it.
- Open issues with the forms in `.github/ISSUE_TEMPLATE/`. Report security
  vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), never in an
  issue.

### Branch protection and required checks

The repository rulesets enforce the following on `main`:

- `protect-main`: changes arrive through a pull request, the branch cannot be
  deleted or force-pushed, only squash merges are allowed, and `ci-ok`,
  `gitleaks`, `e2e-ok` and `pr-size-gate / gate` must pass on the exact head,
  and so must the `Devin Review` check and the organization rulesets
  (`pr-standards`, `CodeQL`). CodeRabbit is advisory, not a required check;
  answer every finding, but its check does not gate the merge. GitHub does not
  require an approving PR review. The repository's independent review policy
  applies to the exact head.

  The journeys count only through the aggregator in e2e.yml: it fails when the
  scope job fails or the browser journeys fail or are cancelled, and passes a
  skipped journey run only on an explicit scope verdict (docs/test-only) or a
  draft.

- `pr-conventions`: `pr-lint` must pass.

The `pr-size-gate` job's check, `pr-size-gate / gate`, is the required size
gate named in the `protect-main` bullet above.

Who merges. In this repository the author merges ordinary PRs after tier review.
Where final technical acceptance applies, that reviewer merges in the approval
run. Fix or answer every finding, verify required checks and pin the squash
merge to the reviewed SHA. Ordinary merges proceed without an owner decision.
Production changes require the [release gate](#production-release-gate).

### Review by risk tier

Declare `risk_tier` in Attestation using the highest tier required by the PR
template and the changed behavior. The [review-tier map](.github/review-tiers.yml)
identifies sensitive paths and triggers. Sensitive changes, including `AGENTS.md`,
`.claude/**`, `CONTRIBUTING.md` and `REVIEW.md`, require at least T1. Changes under
`.github/**` and critical behavior require T0.

| Tier | Examples | Review before merge |
| --- | --- | --- |
| T2 | Ordinary documentation only | Author self-check |
| T1 | Standard code and sensitive contributor instructions | One independent cross-model review |
| T0 | Auth, sessions, payments, SQL or migrations, secrets, grants, cryptography, deploy workflows, Worker config, gateway or voice, erasure, backups | Two independent cross-model reviews in parallel, one general and one security-focused |

Delegate read-only review to a different model family from the author using
[AGENTS.md](AGENTS.md#models-and-effort). Reviewers record the pinned SHA,
findings and verdict independently before reconciling them. The author resolves
findings and obtains fresh verdicts when content or context changes. For an
identical reviewed diff and context, record equivalence and check the new head.

### Merge and production staging evidence

For `TogetherWeOwn/two-web-next` and `TogetherWeOwn/two-bot-next`, staging is
satisfied by the automatic **post-merge, pre-production** staging/e2e/soak gate.
A staging run for an unmerged PR head is not required before merge: staging
accepts only `main`-ancestor SHAs. This applies regardless of the diff's file
types; artifact equality is not a prerequisite for removing that pre-merge
requirement. Do not demand paired artifact hashes or a comparison to current
`main` as a substitute merge prerequisite.

Before merge, require:

1. **Exact-head checks and review.** All required checks listed above
   (`ci-ok`, `gitleaks`, `e2e-ok`, `pr-lint`, `pr-size-gate / gate`,
   `Devin Review`, the organization `pr-standards` workflow and `CodeQL`)
   pass on the exact PR head. Address every CodeRabbit finding. Complete the
   [reviews for the PR's risk tier](#review-by-risk-tier). Record exact-head
   Actions run/job links, conclusions and review evidence.
2. **Check promotion-path routing on the exact head.** Fetch the default
   branch, current target ref and `refs/pull/<pr-number>/head` from the upstream
   repository into a full-history clone. With `gh` authenticated, run the
   read-only classifier from a clean worktree of the trusted upstream default
   branch using `node ci/promotion-path-local.mjs <pr-number> <full-head-sha>`.
   The classifier reads PR metadata and the exact-case live target ref before
   and after checking the local three-dot diff, including both names on
   renames. Record its trusted revision, PR number, head SHA, target ref and
   live tip SHA, reported PR base SHA, merge-base SHA and verdict in the PR.
   Use the live target tip for the comparison because the reported PR base
   can lag it. Route a `yes` verdict through T0 review.

   Even with a classifier `no`, inspect what the diff changes in the live
   target's context. Route to T0 review for new or changed tooling
   or inputs that qualify, select, migrate, deploy or roll back a production
   candidate, whether automatic or manual. This includes changes to what a
   staging check measures. Check workflows, deploy and binding config; the
   classifier's path list is not exhaustive. If the local verdict is
   missing, stale or incomplete, record a direct review of the full three-dot
   diff from the live target tip to the exact head, including both sides of
   renames, to verify `no`. Use T0 review if the diff may affect the promotion
   path and the available evidence cannot establish `no`.

   For a promotion-path PR, record migration evidence or "no migration" and,
   where applicable, the rollback target and qualification route. A present or
   uncertain automatic production path requires exact-head technical release
   acceptance after T0 review under the [organization standard](https://github.com/TogetherWeOwn/.github/blob/main/STANDARD.md#2-pr-review-and-merge).
   A later production deploy or migration requires separate release approval.
3. **Pin the merge and record the result.** Before merging, reread the target
   ref, live tip, reported PR base, three-dot merge base and head SHA. Reassess
   the diff and routing if any changed, and obtain fresh verdicts if the diff
   or review context changed. Verify review coverage and checks on the head.
   Resolve threads once fixed or answered with evidence. Pin the squash merge
   to that head. After GitHub confirms the merge, record the reviewed head,
   squash SHA and any required final technical acceptance in the release log.

   Production holds and staging rollback-drill checks govern production
   deployment, not a merge that does not deploy to production. Keep any
   explicitly applicable merge freeze and other incident or identity/capability
   safeguards in force. An otherwise mergeable PR need not be
   restacked solely because `main` moved.

After merge, the resulting **exact `main` SHA** must pass the existing full CI,
staging deploy, staging e2e and soak gates before automatic production
promotion. Here the path is [deploy.yml](.github/workflows/deploy.yml),
[e2e-staging.yml](.github/workflows/e2e-staging.yml), then the promotion guard in
[deploy-production.yml](.github/workflows/deploy-production.yml). Record the
candidate SHA and matching Actions run/job links as that evidence becomes
available; a PR-head pass or a different `main` SHA does not qualify the
production candidate. See the [deployment runbook](docs/runbook.md#deploy-and-record-the-rollback-pointer)
for the existing staging, promotion, migration and rollback checks. Missing or
failing post-merge qualification holds production promotion, not a request to
stage the unmerged PR first.

The automatic path is not a promise that every merged SHA becomes eligible.
Currently `e2e-staging.yml` scope-skips `staging-journeys` and `staging-passive`
for docs/test-only deploys. Those skips are not passing qualification evidence;
`ci/resolve-promotion-sha.mjs` requires successful journeys and executed quality
checks in a post-deploy `workflow_run`, plus soak, for automatic selection.
If releasing a scope-skipped candidate, run `e2e-staging` by manual dispatch
from the matching deployed `main` revision after merge to obtain the missing
journey/passive evidence. The automatic resolver does not select manual-dispatch
runs, so this does not itself make that SHA auto-promotable. Any explicit
production dispatch requires exact-SHA release approval and all existing
promotion, migration and rollback guards. Hold promotion if matching evidence
cannot be obtained.

### Production release gate

Own each production deploy, data or schema migration, secret or grant change,
and production configuration or flag change as a separate release task. Before
the change, record all of the following in the task:

1. Required checks passed on the exact candidate commit or artifact and every
   included PR received the reviews for its tier.
2. The exact candidate ran on staging and passed its staging checks and smoke
   test. Retain the soak and candidate verification required above.
3. Resolve recovery blockers and retain incident and staging rollback-drill
   guards. Take and verify a backup or snapshot before data or schema changes.
   Document the previous version and rollback or restore path, rehearsed where supported.
4. A new independent release reviewer from a different model family reviewed
   the plan and evidence and explicitly approved the exact candidate and operation. Follow
   [AGENTS.md](AGENTS.md#review-and-release) for model selection. Resolve any
   blockers before fresh review. Owner-routed approvals and settings stay with the owner.

Use authorized identities for all production changes. Run deploys and migrations
through the existing protected workflows. For other operations, use the existing
protected procedure, such as the [secret rotation procedure](docs/runbook.md#secret-rotation-pointer-procedure-only).
If an operation requires a deployment, hold it until the protected deploy
workflow can execute it.
For automatic promotion, [the resolver](ci/resolve-promotion-sha.mjs) requires the
qualified, soaked staging SHA to equal `PRODUCTION_ACCEPTED_SHA`. An authorized
executor sets that variable to the exact approved SHA only through the existing
access boundary. Manual dispatch also requires exact-candidate approval and the
existing workflow protections. Monitor health and errors for at least 30
minutes after execution. On a regression, roll back promptly through the
protected path. Record the outcome in the release task and product log.

### Pull-request size labels (advisory)

`.github/workflows/pr-size.yml` labels every pull request `size/S` (up to 100
counted lines), `size/M` (up to 400), `size/L` (up to 1000) or `size/XL`, and
keeps one advisory comment on pull requests over the 400-line threshold.
Counted lines are additions + deletions excluding lockfiles, generated files
and fixtures. The labeller lives once in the org
[TogetherWeOwn/.github](https://github.com/TogetherWeOwn/.github) repository
(`CI-STANDARD.md`, "Advisory PR-size labels"); the workflow here is a thin
caller pinned to a central SHA and passes only this repo's generated paths.
The labeller is advisory only: it is not a required check and never blocks a
merge. The same workflow's `pr-size-gate` job is the required size gate,
reported as `pr-size-gate / gate` (see Branch protection and required checks
above). A Monday run of the same workflow
prints the weekly tally of merged pull requests per size; the labels are the
durable record behind it.

### Change-gated CI and `ci-ok`

In Verification, record the observed outcomes and direct run or job
links for the required Actions checks on the exact PR head. Use the PR's check
association to verify the head when an Actions run from a fork lacks that
binding. Include at least one authored Verification item with evidence.

Heavy CI jobs run only when their inputs changed (TOG-14877 CI standard). The
`scope` jobs (in `ci.yml` and the workflows that mirror it) fetch the
changed-file list and the base commit's scope scripts in the only step that
holds a token, then run those base-branch scripts in a token-free step and
publish only validated verdicts: every expected key exactly once, `true` or
`false`. Fast-pass claims (`docs_only`, `skip_e2e`, `full`) are re-derived
from the file list and only ever downgraded toward running more. The
`scope` job in `ci.yml` classifies every pull request into areas — `app`
(served code, assets, tests, journeys), `worker` (dispatch configs, the Tail
worker, the Kit spike), `db` (migrations) — plus `full` (lockfiles,
`.github/**`, shared config, or anything unknown: run everything) and `draft`.
`a11y` runs on app/db, `lighthouse` and `bundle-budget` on app, and `docs-links`
checks relative links and anchors on every PR. `check` runs unless its run was
cancelled and waits for `scope` and `dependency-admission`, not the independent
accessibility or performance jobs. It skips heavy steps on docs-only and draft PRs.
For non-draft code changes, static checks and coverage shards run in parallel after dependency admission.
`ci-ok` requires static checks and coverage replay, which verifies shard inputs before enforcing unchanged floors.
Three independent Kit browser jobs run alongside `check` for non-draft,
non-docs-only full, app or worker scopes. `kit-browser-calendar` runs the
shared fixture cases named `calendar …`; `kit-browser-fixture` runs the rest
and the isolation test. `kit-browser-lifeline` runs the Lifeline test and
uploads its eight screenshots. `ci-ok` requires every selected job's success
and a Lifeline upload ID. Failure, cancellation or an unexpected skip fails
the gate.
The Node 22.23.0 `engines` floor is asserted in each of three `node22-shard`
jobs. The first shard also runs lint and typecheck. Each runs its share of the
unit suite serially against its own Postgres service. For a selected run,
`node22-compat` requires the matrix to succeed and checks that each Vitest
report lists exactly the files assigned by the configured sequencer before
replaying all three reports. It fast-passes on docs-only and draft PRs.
The `ci-ok` aggregator requires `docs-links`, `node22-compat` and every
selected job's result, and reports the overall conclusion. In a run
cancelled by a newer run on the same PR, both conclude cancelled rather than
failed, and the newer run's `ci-ok` decides the merge. Main pushes and the nightly schedule
run the full suite. The `ci-ok`-as-required-check ruleset cutover is an
OPERATOR step after merge plus green probes — never part of a PR.

During each Node 22 shard, `ci/node22-progress.mjs` emits a
`[node22-progress]` JSON snapshot immediately and every 60 seconds, at most
43 times (through minute 42). Each snapshot has at most 32 process rows and
8 KiB of output. It observes the step shell's main-thread descendant tree,
excluding itself: numeric PIDs/parents, state, cumulative CPU ticks, RSS pages,
thread counts and process-start ticks. Compare consecutive rows for CPU or
resource changes alongside the existing test output; these are observations,
not proof of a particular hang or its cause. `truncated` marks incomplete tree
reads/caps; unavailable or replaced roots stop the sampler with a fixed message.
No argv, environment, names, test output, stack/heap dumps or database queries
are collected. The sidecar never signals the suite, and its cleanup does not
replace the original command's exit status or extend the 45-minute job timeout.
Its selftests use only local proc fixtures and controlled child processes.

### What fails `pr-lint` today vs what only warns

`pr-lint` is a required job, so it must pass; inside the job, some findings
fail it and some only warn. Current mode in
`.github/workflows/pr-gates.yml`: `INTERNAL_ID_LEVEL: "warning"`,
`PR_STANDARDS_MODE: "warn"`, `HEAD_REF_ERROR_FROM_PR: "627"`, and
`RISK_TIER_ERROR_FROM_PR: "2671"`. A finding that
fails exits the checker nonzero and turns the job red; a warning is annotated
without failing. Flipping a knob to `"error"` turns the Warns-only rows that
name it into failures, so update this table in the same change. The strict
title/body subset always fails regardless of either knob; a commit-subject hit
needs `INTERNAL_ID_LEVEL`, and the Linked Issues, advisory and
below-cutoff branch rows need `PR_STANDARDS_MODE`.

| Check | Result today |
| --- | --- |
| PR title is not a Conventional Commits title, exceeds 100 characters, or ends with a period (`ci/check-pr-conventions.py` and `.github/scripts/pr_standards.py`) | Fails `pr-lint` |
| Empty body: fewer than 40 non-space characters after stripping HTML comments | Fails `pr-lint` |
| Push to main carries a bypass commit message that is not a Conventional Commits header (squash-merge bypass) | Fails `pr-lint` |
| Net growth from the fork point in the internal-card-ID and instance-UI-link tracked-file ratchet (`.github/scripts/internal_ref_ratchet.py`); unreadable trees also fail closed | Fails `pr-lint` |
| Branch-name internal ID on a PR numbered at or above the cutoff (`HEAD_REF_ERROR_FROM_PR: "627"`) | Fails `pr-lint` |
| Missing, invalid or understated `risk_tier` on a PR numbered at or above `RISK_TIER_ERROR_FROM_PR` | Fails `pr-lint` |
| Missing or thin Linked Issues or Issue Description section (upstream gate, `PR_STANDARDS_MODE: "warn"`) | Warns only |
| Missing Verification evidence or a Verification bullet without a code-formatted command and observed result or a GitHub Actions run/job URL (`PR_VERIFICATION_MODE: "error"`) | Fails `pr-lint` |
| Tracker ID, instance UI link or the internal host in the PR title or body (upstream strict subset, always fails) | Fails `pr-lint` |
| Internal card ID in a commit subject (first checker, `INTERNAL_ID_LEVEL: "warning"`) | Warns only |
| Advisory references in the PR title or body, or an internal reference in the branch name below the cutoff (upstream gate, `PR_STANDARDS_MODE: "warn"`) | Warns only |

GitHub does not enforce an approval count here. Follow the repository review
policy above. Devin Review is a required
check that runs on the head SHA and re-runs on a new push, plus CodeRabbit,
whose check is advisory:
its findings must each be fixed or answered with evidence, but the check never
blocks the merge. Review conversations still follow the required thread
resolution in "Branch protection and required checks", so resolve each
conversation once it is fixed or answered. The merge rule is the one in
"Who merges" above.

`pr-lint` lives in `.github/workflows/pr-gates.yml` and runs through
`ci/pr-lint-output.py check`: first `ci/check-pr-conventions.py` (it fails on a
title that is not a Conventional Commits header, a title over 100 characters or
ending in a period, and an empty body; its internal-ID check is a warning
today, and `INTERNAL_ID_LEVEL` in the workflow turns it into an error), then
`.github/scripts/pr_standards.py` for pull requests when the workflow sets
`PR_STANDARDS_MODE`. A tracker ID, instance UI link or the internal host in a
public title or body always fails, comments included. The advisory body, branch
and reference rules follow the mode (`PR_STANDARDS_MODE: "warn"`); the flip to
`"error"` is a separate one-line change once the repo's open PRs are clear. The
script is unit-tested beside it: `python3 -m unittest discover -s .github/scripts -p
'test_pr_standards.py'`.

The risk-tier check uses the [PR template's path floors](.github/pull_request_template.md#attestation)
and the complete three-dot Git diff from the fetched target tip to the checked
PR head. Both sides of a rename count. Declare `T0`, `T1` or `T2` in Attestation
and escalate when the behavior warrants it. Follow [review by risk tier](#review-by-risk-tier)
to route the review. PRs opened before the cutoff keep their existing
metadata checks. For generated dependency PRs covered by the cutoff, a
maintainer adds the declaration to the PR body.

### Secret-scan allowlists

The required `gitleaks` job (also in `pr-gates.yml`) scans the full history
reachable from the checked-out commit. On pull requests, this starts at GitHub's
PR merge commit, not the submitted branch tip. The scan forces text diffs and
compares each merge with its first parent, including conflict resolutions.
That comparison can report content inherited from another parent under the
merge SHA. Use commit-scoped ignore fingerprints to limit an exception to one
occurrence. A fingerprint scoped to the original commit does not also exempt
the merge occurrence.

On a pull request the job applies the base branch's
`.gitleaks.toml` and `.gitleaksignore` and ignores inline `gitleaks:allow`
comments, so a PR cannot allowlist its own leak. If a change legitimately needs a
new allowlist entry, merge that entry first as a small, separately reviewed PR;
the next scan honours it. A new fixture that trips a rule therefore waits for that
entry, or uses a value an existing entry already covers. Push-to-main scans use
the repository's own files. Run `GITLEAKS_BIN=<path>
.github/scripts/test-gitleaks-scan.sh` to repeat the offline self-test the job
runs. The scanner archive is pinned by SHA-256 in `pr-gates.yml`; bump
`GITLEAKS_SHA256` from the release's `gitleaks_<version>_checksums.txt` together
with `GITLEAKS_VERSION`.

## Dependency security and static analysis

The `dependency-admission` job runs the audit selftests, npm policy fixtures,
lockfile audit and dependency-pin guard once, without a database or a workspace
install. `check` requires its success before installing dependencies, and `ci-ok`
requires its explicit success. Both jobs share an exact Node patch release so
`check` installs with the npm release that passed the policy fixtures. To refresh
audit evidence, rerun all jobs; rerunning only failed jobs can reuse successful
admission. Only docs-only and draft PRs fast-pass inside the job. The audit reads
every lockfile root (`package-lock.json` and
`web/package-lock.json`), includes development/optional/peer dependencies, and
blocks high, critical or unknown severity. It prints one result per lockfile
(`.` and `web`) and fails when either has a non-excepted finding. A missing
lockfile for either root fails closed on every event. It forces online
auditing even when npm's environment or `.npmrc`
enables offline mode, using a fresh per-lockfile cache rather than the restored
installation cache (which can retain stale advisory severity). The owned audit
caches are removed on success or failure. A child-only Node preload also validates
the exact raw bulk advisory response before npm can normalize it. A clean `{}`
is valid; `null`, arrays and missing/unknown advisory severities are not. The
preload observes bounded HTTP/HTTPS bodies (including compressed responses),
without changing registry selection, authentication or response bytes. Its
separate validation pipe journals counters/booleans and fixed transport codes/statuses,
not registry data. Progress is written before npm consumes it and survives a timeout kill.
Missing/incomplete validation, unsupported audit redirects/legacy quick fallback,
and a future npm transport that escapes observation fail closed. The gate requires
an observed valid bulk response, even for a lockfile with no audit candidates.
Cyclic `via` references are traversed once per reachable package, retaining every
advisory ID and blocking severity. Invalid JSON, malformed/inconsistent severity
counters, missing references, registry/process failures and invalid/expired
exceptions also fail closed.
Each lockfile gets 3 attempts with 5s/15s backoff and a fresh owned cache per
attempt. When every attempt fails with a positively identified registry
transport fault, the gate records that lockfile as unavailable, never clean:
a 120s timeout with an observed bulk request still pending and no permanent
validation failure, or a fault confirmed by the preload's observation of the
bulk request: a typed request-error code (ECONNREFUSED,
ECONNRESET, EPIPE, ETIMEDOUT, EAI_AGAIN, ENOTFOUND, ECONNABORTED, ENETUNREACH,
EHOSTUNREACH, ENETRESET, ENETDOWN, EHOSTDOWN) at the bulk advisory endpoint, or
an HTTP 5xx from that endpoint. Response-body/message/URL tokens never supply
transport evidence. Invalid responses remain blocking even if npm later stalls;
a timeout before any observed bulk request and mixed crash/outage exhaustion also
remain blocking. Policy schema, duplicates and expiry are validated before any
audit, independently of availability. The gate still audits the other lockfile,
so an advisory there keeps blocking. On `pull_request` and `merge_group` an outage with no blocking
finding annotates a bounded, redacted `::warning::` (lockfile, kind, attempts;
no URLs, bodies, or tokens) and exits 0. On `push` (main), `schedule`,
`workflow_dispatch`, and local runs the same outage fails closed with exit 1.
Crashes, signal kills, HTTP 4xx (including 401/403), malformed bodies,
unobserved transport, and a missing npm or preload always fail closed on every
event; completed permanent failures never retry.
Info/low/moderate findings do not block. Dependabot owns dependency upgrades;
the gate never runs `npm audit fix`.

`ci/deps-audit-allowlist.json` starts empty. A reviewed exception has this shape:

```json
{
  "package": "affected-package",
  "range": "<2.0.0",
  "severity": "high",
  "advisoryIds": [100001],
  "reviewed": "2026-09-30",
  "expires": "2026-10-07",
  "reason": "Why this risk is temporarily accepted; tracking issue and mitigation"
}
```

An exception may add an optional `lockfile` scope (`"."` or `"web"`). An
exception without `lockfile` applies to both lockfiles; an exception with
`lockfile` applies only to that lockfile.

Add it to `exceptions` only through a reviewed PR. Match the audit's exact package,
range, severity and complete numeric advisory ID set (including transitive
`via` references). New advisories/ranges/severity invalidate the exception.
Use real UTC dates; the expiry day itself is blocking, even if the exception is
unused. Unknown severity cannot be exempted. Remove expired exceptions rather
than silently extending them. Fixture examples are synthetic, not accepted risks.

Some advisories have no fixed upstream release to upgrade to. Where a patched
transitive release exists but the direct dependency has not adopted it, pin it
with an exact `overrides` entry in `package.json`, scoped under the affected
consumer rather than at the top level, and verify the consumer's actual API
use before merging. A top-level pin rewrites every copy in the tree,
including toolchain copies another tool pins for itself. Remove the pin once
the direct dependency ships the fix itself.

One monitored low-severity exception is open (reviewed 2026-11-01):
`deepmerge` GHSA-gcqx-w48m-w2h4 in `web/`, pulled in by
`@sveltejs/vite-plugin-svelte`. No patched `deepmerge` release exists yet.
It runs only at build time, merging this repository's own plugin and Vite
configuration objects; it takes no untrusted input and ships in no Worker
bundle. Low findings do not block the audit gate, so this note is the record;
delete it when a patched `deepmerge` ships or the plugin drops the
dependency.

CodeQL uses the repository's existing default setup for JavaScript/TypeScript,
Actions and Python. Keep that coverage intact; do not add a competing advanced
workflow or change repository scanning settings as part of the dependency gate.

## Releases

Each successful production promote tags the deployed commit `vYYYY.MDD.P` and
publishes a GitHub Release from the Conventional Commit subjects since the
previous stable tag (`release.yml`, called by `deploy-production`, through the
shared CalVer releaser in `TogetherWeOwn/.github`). There is no release PR and
no release commit. See [`docs/releases.md`](docs/releases.md). Never tag or
release by hand.

Release notes use the [Common Changelog](https://common-changelog.org/)
categories, in its order: **Changed** (`perf`, `revert`), **Added** (`feat`),
**Fixed** (`fix`, `security`). `chore`, `docs`, `test`, `ci`, `build`, `refactor` and `style`
stay out of the notes. Each squash-merged PR title becomes one entry, so
write it for a reader of the release notes: imperative mood, one user-facing change.

Versioning is calendar-based (CalVer, upstream Paperclip syntax): `YYYY.MDD.P`
is the UTC promote date plus a counter from 0, so the second release on
2026-11-04 is `v2026.1104.1`. The commit type no longer changes the version;
`feat!` / `BREAKING CHANGE` only lists the change first in the notes. Earlier
releases used SemVer, from `v1.0.0` at the production cutover (2026-10-18) to
`v1.21.2`; those tags stay.

## Local development

```sh
npm ci --include=dev
cp .dev.vars.example .dev.vars   # fill in locally; never commit
npm run dev
npm run format                   # formatting only; never rewrites lint violations
npm run lint                     # read-only Biome lint + format gate
npm run check                    # lint + format + typecheck + config drift + tests
```

### Verify a change before opening a PR

#### AI contributors: exact-head GitHub Actions

Full suites and CI gates run only on GitHub Actions for the exact PR head.
Keep the PR in draft until implementation is complete and the checks that run
on drafts pass on that head. Record their run/job links and conclusions and all
other required before-ready evidence in Verification. If a draft check does not
produce required changed-behavior proof, use the relevant focused Actions
workflow where available. Do not dispatch full CI just because the draft skips
heavy jobs.

Mark that head ready to trigger the normal PR CI and E2E runs. Before submitting
for tier review, verify the required checks passed on that same head and
record the run/job links and conclusions in Verification. Changes to `src/`,
`test/` or migrations still require the full gate; draft or scope-skipped jobs
are not a full-suite pass. Every required check, database-safety rule, tier
review and release gate remains in force.

Local agent test execution is limited to the bounded pre-push fixture checks
below and, when Actions cannot run it, an authorized focused reproduction of
one failing non-Rust test. Neither the builder nor its caller may run local
full suites or CI mirrors on the shared host, in Boat or through a fallback;
do not split a suite into successive focused commands. Do not use Boat or a
heavy raw-host fallback for non-Cargo work. If no compliant path is available,
defer to Actions or route the actual prerequisite. Report focused reproduction
output separately as diagnostic evidence; it does not replace Actions evidence.
Read-only reviewers inspect source and existing evidence and do not execute
tests, builds or installs.

Before every push, agents verify a fresh worktree with a bounded,
offline-fixture set of checks. GitHub Actions is the only place agents run the
full suite, the database tests, Docker and the browser gates.

Install once per worktree and reuse it unless a lockfile changes. Project npm
configuration disables lifecycle scripts by default; keep `--ignore-scripts`
explicit and use a per-task npm cache. `npm ci`
uses the frozen lockfile and its integrity checks; this change does not add or
update dependencies. Although npm 11.19 accepts `--min-release-age`, it does not
enforce that age on locked packages installed by `npm ci`. Do not treat this
command as a package-age check. Use the Node floor stated in the README.

```sh
nice timeout -k 10 300 npm ci --include=dev --ignore-scripts --min-release-age=3 --no-audit --no-fund --cache "$PAPERCLIP_TASK_SCRATCH_DIR/npm-cache"
nice timeout -k 10 120 npm run generate:first-party
nice timeout -k 10 120 npm run typecheck
nice timeout -k 10 300 env -u DATABASE_URL -u BOT_DATABASE_URL npm run test:unit -- test/leaf-css-build-time.test.ts test/leaf-css-drift.test.ts
```

- `--ignore-scripts` suppresses npm pre and post hooks, so `postinstall` and
  `pretypecheck` do not run. `npm run typecheck` therefore runs the generator
  itself: `node ci/build-leaf-css.mjs && tsc --noEmit && tsc --noEmit -p ci/tsconfig.json`.
- `npm run test:unit` is `node ci/test-unit.mjs`. It requires explicit, exact
  `test/*.test.ts` paths and rejects no arguments, invalid names, directories,
  flags, globs and missing paths. It regenerates the same critical-CSS module
  through the generator before Vitest and does not build the app. Run tests
  separately from typecheck; neither depends on the other.
- Choose test files beside the code you changed and the files that import it
  (`git grep -l <module> test/`). Pick only fixtures that run offline. The two
  files above are an example. Do not provide `DATABASE_URL` or any credential.
- Format and lint each changed file with a 120 second limit, for example
  `nice timeout -k 10 120 npm exec --no -- biome format package.json ci/test-unit.mjs test/<file>.test.ts`,
  then `nice timeout -k 10 120 npm exec --no -- biome check --error-on-warnings <same paths>`.
- Precheck resources first. If the load average exceeds `nproc`, `MemAvailable`
  is under 10% of total memory, or `/home` has 85% or more used, skip the
  install-dependent checks and record that you skipped them and why.
- Clean up only what you created: remove the worktree's `node_modules` and the
  per-task npm cache when you finish.
- Run in Actions only, on the exact head SHA: `npm run check`, the full build,
  database tests, Docker and the browser, a11y and Kit gates. Cite that head's
  results as evidence. Do not claim a result you did not see.

The command examples in Local development and the human workflow below are
a tooling reference, not an exception to these agent execution limits.

#### Human contributors: local verification

`bin/local-ci.sh` (also `npm run ci:local --`) reproduces the Vitest gates of
the CI `check` job on any host with Docker. It needs no `.dev.vars` and no
credentials. Network access is needed only to pull `node:24-bookworm` and
`postgres:17`, and for `npm ci` to reach the npm registry when the local npm
cache is cold. Each shard gets its own disposable Postgres 17 container on its
own Docker network, aliased `agent-testdb` so the `testDatabaseUrl` guard
accepts it. Nothing is published on host ports. Suites run in the CI job image
as your user. Containers and networks are removed on exit.

```sh
bin/local-ci.sh -- test/events.test.ts test/event-page.test.ts  # only the affected files
bin/local-ci.sh -- test/admin                                   # every file matching a filter
bin/local-ci.sh -j 8                                            # full gate on 8 shards
bin/local-ci.sh -j 8 --no-coverage --no-static                  # suite only, quicker
```

- Focused runs apply migrations to a fresh database and run `vitest run` on the
  given files or filters. Start with the test files beside the code you changed
  and the files that import it (`git grep -l <module> test/`).
- A full run does lint, typecheck, migrations, and `vitest run --coverage`
  split over `-j N` shards (default `nproc / 4` capped at 8; up to 16 explicitly). It then merges the
  shard reports, so pass counts and coverage thresholds cover the whole suite.
  Last, it reruns the hotzone suite under `TZ=America/Los_Angeles` and runs Tier-0.
  Shard logs are in `.local-ci/<run>/logs/`, so concurrent runs never share files.
- `npm ci` (root and `web/`) runs inside the CI image the first time and again
  whenever a lockfile changes. `--install` forces it. Each run holds a shared lock
  on the dependencies while it runs, and an install waits for the exclusive lock, so
  `npm ci` never replaces `node_modules` under another run in the same checkout.
- Human contributors run the full local gate before opening a PR that touches
  `src/`, `test/` or migrations and paste the merged `Test Files` / `Tests` lines
  into Verification. AI contributors instead follow the Actions-only workflow
  above; neither the builder nor its caller runs this local gate.
- Not covered: the browser journeys (`e2e-ok`), the a11y job, the Kit build and
  parity gates, and Semgrep. CI still runs them on the PR.

`bin/local-ci.sh` (also `npm run ci:local --`) is a human workflow; agents do
not run it. Agents do not run the full suite locally; use the Actions run instead.

Biome is pinned in `package-lock.json`. `npm run lint` uses the read-only
[`biome ci`](https://biomejs.dev/reference/cli/#biome-ci) command to enforce both
lint and formatting. `npm run format` only formats; it does not apply lint fixes
or reorder imports. `npm run check` runs this gate; CI runs it before typecheck
and in parallel with coverage. The `check` job proves rejection
of debugger statements, unused variables, floating promises and bad formatting
with `bash ci/biome-selftest.sh`.

The rule set is deliberately opt-in (`preset: none`): basic correctness checks,
unused variables and floating promises, not opinionated style or accessibility
rewrites. Generated Drizzle metadata, the npm lockfile and build/dependency
outputs are excluded. The existing island sources under `assets/islands/`
retain narrow compatibility exceptions: `events-calendar.js` permits the
unused catch variable `e`, and it, `member-profile.js` and `past-events.js`
disable `noFloatingPromises` for their existing fire-and-forget handlers.
The minified build output under `public/islands/` skips both lint and format:
it is reviewed as bytes, with `npm run build:assets:check` failing on drift.
The staging spike
`staging-checks.ts` disables only `noUnsafeFinally` for its existing fail-closed
cleanup-verification throw in `finally`; its control flow remains unchanged.
All other files keep the selected rules. Tightening these exceptions is separate
behavioral work.
The four standalone importer tests (`import-audit.test.ts`,
`import-events-rsvps.test.ts`, `import-events-target-separation.test.ts` and
`import-backfill-portable.test.ts`) use a 140-column formatter override to keep their
existing `@ts-expect-error` imports on one line; wrapping would detach the directive
from TypeScript's module diagnostic. `assets/styles.css`, `public/styles.css`,
`public/theme.css`,
`public/profile-theme.css`, `public/schedule-theme.css`, `public/event-theme.css` and
`ci/a11y.mjs` are not formatted because existing regression tests assert exact stylesheet bytes,
source-order substrings and single-line selector scoping. `ci/featured-proof/**` also retains its immutable,
hash-verified proof inputs byte-for-byte. Their content, hashes and regression
assertions remain unchanged. Biome 2.6 adds Markdown and YAML formatting; this
repo adopts the YAML formatter, but Markdown (`**/*.md`) stays unformatted for
now: the 2.6.2 Markdown formatter joins words around inline code in several
docs, never reaches a fixed point on the retention-ledger table, and rewrites
JSON fences that docs quote as exact machine output. Adopting it also keeps
the published `content/privacy-policy-v*.md` texts byte-stable, as the
privacy-history tests require. Revisit when upstream fixes those defects.
These formatter exemptions disable neither lint nor
typecheck. Lint exemptions are limited to `public/islands/**` and the hash-pinned
`ci/featured-proof/fixtures/**`; `ci/a11y.mjs`, the other featured-proof files and the
stylesheets are still linted.
Configuration options follow the [Biome configuration reference](https://biomejs.dev/reference/configuration/).

Never commit secrets, `.dev.vars` or `node_modules/`. Run tests only against the
disposable test database or local fixtures described in [README.md](README.md),
never against a production or staging database. See the README for the full
configuration reference.
