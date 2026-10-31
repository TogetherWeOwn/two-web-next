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
  sentences. In the current warn mode `pr-lint` warns (does not fail) on a
  missing or thin Linked Issues or Issue Description and Verification; the
  other sections are optional. See "What fails `pr-lint` today vs what only
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
- Be honest about the tests. Give the exact commands you ran and their results in
  Verification, and say what you did not run. Never claim a green run you did not see.
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
  `gitleaks` and `e2e-ok` must pass on the exact head, and so must the two
  review app checks, CodeRabbit and Devin Review. No approving review is
  required.

  The journeys count only through the aggregator in e2e.yml: it fails when the
  scope job fails or the browser journeys fail or are cancelled, and passes a
  skipped journey run only on an explicit scope verdict (docs/test-only) or a
  draft.

- `pr-conventions`: `pr-lint` must pass.

Who merges (owner decision 2026-10-31): the agent that did the work merges a PR
once every required check is green and each review finding is fixed or answered
with evidence. A merge to `main` deploys production (ci, then deploy, then
e2e-staging, then deploy-production), so it also needs the owner's approval
through `request_confirmation` on the card. So does every other production
deploy, such as a manual dispatch or promotion.

### Pull-request size labels (advisory)

`.github/workflows/pr-size.yml` labels every pull request `size/S` (up to 100
counted lines), `size/M` (up to 400), `size/L` (up to 1000) or `size/XL`, and
keeps one advisory comment on pull requests over the 400-line threshold.
Counted lines are additions + deletions excluding lockfiles, generated files
and fixtures. The labeller lives once in the org
[TogetherWeOwn/.github](https://github.com/TogetherWeOwn/.github) repository
(`CI-STANDARD.md`, "Advisory PR-size labels"); the workflow here is a thin
caller pinned to a central SHA and passes only this repo's generated paths.
This is advisory only: it is not a required check and never blocks a merge.
A Monday run of the same workflow prints the weekly tally of merged pull
requests per size; the labels are the durable record behind it.

### Change-gated CI and `ci-ok`

Heavy CI jobs run only when their inputs changed (TOG-14877 CI standard). The
`scope` job in `ci.yml` classifies every pull request into areas — `app`
(served code, assets, tests, journeys), `worker` (dispatch configs, the Tail
worker, the Kit spike), `db` (migrations) — plus `full` (lockfiles,
`.github/**`, shared config, or anything unknown: run everything) and `draft`.
`a11y` runs on app/db, `lighthouse` and `bundle-budget` on app, and `docs-links`
checks relative links and anchors on every PR. `check` runs unless its run was
cancelled, starts from `scope` alone so it runs in parallel with the audit
and performance jobs, and skips its heavy steps on docs-only and draft PRs.
`node22-compat` reports the same way on the exact Node 22.23.0 `engines`
floor — the version asserted in its log — running lint, typecheck and the
unit suite, so the declared 22 range is verified beside the Node 24 jobs;
the `ci-ok` aggregator requires `docs-links`, `node22-compat` and every
selected job's result, and reports the overall conclusion. In a run
cancelled by a newer run on the same PR, both conclude cancelled rather than
failed, and the newer run's `ci-ok` decides the merge. Main pushes and the nightly schedule
run the full suite. The `ci-ok`-as-required-check ruleset cutover is an
OPERATOR step after merge plus green probes — never part of a PR.

During Node 22 lint/typecheck/tests, `ci/node22-progress.mjs` emits a
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
`PR_STANDARDS_MODE: "warn"`, `HEAD_REF_ERROR_FROM_PR: "627"`. A finding that
fails exits the checker nonzero and turns the job red; a warning is annotated
without failing. Flipping a knob to `"error"` turns the Warns-only rows that
name it into failures, so update this table in the same change. The strict
title/body subset always fails regardless of either knob; a commit-subject hit
needs `INTERNAL_ID_LEVEL`, and the Linked Issues, Verification, advisory and
below-cutoff branch rows need `PR_STANDARDS_MODE`.

| Check | Result today |
| --- | --- |
| PR title is not a Conventional Commits title, exceeds 100 characters, or ends with a period (`ci/check-pr-conventions.py` and `.github/scripts/pr_standards.py`) | Fails `pr-lint` |
| Empty body: fewer than 40 non-space characters after stripping HTML comments | Fails `pr-lint` |
| Push to main carries a bypass commit message that is not a Conventional Commits header (squash-merge bypass) | Fails `pr-lint` |
| Net growth from the fork point in the internal-card-ID and instance-UI-link tracked-file ratchet (`.github/scripts/internal_ref_ratchet.py`); unreadable trees also fail closed | Fails `pr-lint` |
| Branch-name internal ID on a PR numbered at or above the cutoff (`HEAD_REF_ERROR_FROM_PR: "627"`) | Fails `pr-lint` |
| Missing or thin Linked Issues or Issue Description section (upstream gate, `PR_STANDARDS_MODE: "warn"`) | Warns only |
| Missing or thin Verification section (upstream gate, `PR_STANDARDS_MODE: "warn"`) | Warns only |
| Tracker ID, instance UI link or the internal host in the PR title or body (upstream strict subset, always fails) | Fails `pr-lint` |
| Internal card ID in a commit subject (first checker, `INTERNAL_ID_LEVEL: "warning"`) | Warns only |
| Advisory references in the PR title or body, or an internal reference in the branch name below the cutoff (upstream gate, `PR_STANDARDS_MODE: "warn"`) | Warns only |

GitHub does not enforce an approval count here. Team policy does: an independent
reviewer, who did not write the change, reviews the exact head SHA that merges, CI
is green on that SHA, and a new push needs a new review.

`pr-lint` lives in `.github/workflows/pr-gates.yml` and runs through
`ci/pr-lint-output.py check`: first `ci/check-pr-conventions.py` (it fails on a
title that is not a Conventional Commits header, a title over 100 characters or
ending in a period, and an empty body; its internal-ID check is a warning
today, and `INTERNAL_ID_LEVEL` in the workflow turns it into an error), then
`.github/scripts/pr_standards.py` for pull requests when the workflow sets
`PR_STANDARDS_MODE`. A tracker ID, instance UI link or the internal host in a
public title or body always fails, comments included; the remaining body, branch
and reference rules follow the mode (`PR_STANDARDS_MODE: "warn"`); the flip to
`"error"` is a separate one-line change once the repo's open PRs are clear. The
script is unit-tested beside it: `python3 -m unittest discover -s .github/scripts -p
'test_pr_standards.py'`.

### Secret-scan allowlists

The required `gitleaks` job (also in `pr-gates.yml`) scans the full history
reachable from the PR head. On a pull request it applies the base branch's
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

The `check` job runs `npm run deps:audit:selftest` (local fixtures,
including a loopback registry) and `npm run deps:audit` before installing
dependencies. The audit reads every lockfile root (`package-lock.json` and
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

CodeQL uses the repository's existing default setup for JavaScript/TypeScript,
Actions and Python. Keep that coverage intact; do not add a competing advanced
workflow or change repository scanning settings as part of the dependency gate.

## Releases

Each successful production promote tags the deployed commit `vX.Y.Z` and
publishes a GitHub Release from the Conventional Commit subjects since the
previous tag (`release.yml`, called by `deploy-production`). There is no release
PR. See [`docs/releases.md`](docs/releases.md). Never tag or release by hand.

Release notes use the [Common Changelog](https://common-changelog.org/)
categories, in its order: **Changed** (`perf`, `revert`), **Added** (`feat`),
**Fixed** (`fix`, `security`). `chore`, `docs`, `test`, `ci`, `build`, `refactor` and `style`
stay out of the notes. Each squash-merged PR title becomes one entry, so
write it for a reader of the release notes: imperative mood, one user-facing change.

Versioning is SemVer, starting at `0.1.0`; `1.0.0` marks the production
cutover: `release-as: 1.0.0` in `release-please-config.json` makes the
cutover promote cut `v1.0.0`. Before `1.0.0`, `feat!` / `BREAKING CHANGE` bumps the minor version;
from `1.0.0` onward, it bumps the major version.

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
- Run the full gate before you open a PR that touches `src/`, `test/` or
  migrations. Paste the merged `Test Files` / `Tests` lines into Verification.
- Not covered: the browser journeys (`e2e-ok`), the a11y job, the Kit build and
  parity gates, and Semgrep. CI still runs them on the PR.

Biome is pinned in `package-lock.json`. `npm run lint` uses the read-only
[`biome ci`](https://biomejs.dev/reference/cli/#biome-ci) command to enforce both
lint and formatting. `npm run format` only formats; it does not apply lint fixes
or reorder imports. `npm run check` runs this gate; CI runs it before typecheck
and coverage, alongside the configuration drift check, and proves rejection
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
