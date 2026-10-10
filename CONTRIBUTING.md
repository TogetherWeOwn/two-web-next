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
  sentences. `pr-lint` requires Linked Issues or Issue Description and
  Verification (commands run and their results); the other sections are optional.
- Link a public GitHub issue with `Closes #123`, or describe the problem in the PR.
  No card reference is required. `docs`, `chore`, `build`, `ci`, `style`, `test` and
  `revert` PRs need no linked issue.
- Search first. Look for an open or recent PR that touches the same area, and link
  what you find.
- Keep references public-safe. Do not put internal card IDs (`TOG-` or `PAP-`
  followed by digits), private URLs, tokens or secrets in any title, body, commit,
  comment or branch name. `pr-lint` warns when it finds a card ID in the title, body
  or a commit subject, and in the branch name in any letter case (`qa/tog-123-x`).
- Every PR, including docs-only and draft heads, must not increase the total count of internal card IDs and instance-UI links in tracked files versus its base; `pr-lint` enforces this with named lint-fixture exclusions only.
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
  deleted or force-pushed, only squash merges are allowed, and `check` and
  `gitleaks` must pass.
- `pr-conventions`: `pr-lint` must pass.

### Change-gated CI and `ci-ok`

Heavy CI jobs run only when their inputs changed (TOG-14877 CI standard). The
`scope` job in `ci.yml` classifies every pull request into areas — `app`
(served code, assets, tests, journeys), `worker` (dispatch configs, the Tail
worker, the Kit spike), `db` (migrations) — plus `full` (lockfiles,
`.github/**`, shared config, or anything unknown: run everything) and `draft`.
`a11y` runs on app/db, `lighthouse` and `bundle-budget` on app, and `docs-links`
checks relative links and anchors on every PR. `check` always runs, skips its
heavy steps on docs-only and draft PRs, and requires `docs-links`; the `ci-ok`
aggregator reports the overall conclusion. Main pushes and the nightly schedule
run the full suite. The `ci-ok`-as-required-check ruleset cutover is an
OPERATOR step after merge plus green probes — never part of a PR.

GitHub does not enforce an approval count here. Team policy does: an independent
reviewer, who did not write the change, reviews the exact head SHA that merges, CI
is green on that SHA, and a new push needs a new review.

`pr-lint` lives in `.github/workflows/pr-gates.yml` and runs through
`ci/pr-lint-output.py check`: first `ci/check-pr-conventions.py` (it fails on a
title that is not a Conventional Commits header, a title over 100 characters or
ending in a period, and an empty body; its internal-ID check is a warning
today, and `INTERNAL_ID_LEVEL` in the workflow turns it into an error), then
`.github/scripts/pr_standards.py` for pull requests when the workflow sets
`PR_STANDARDS_MODE`. The upstream body, branch and reference rules start as
warnings (`PR_STANDARDS_MODE: "warn"`); the flip to `"error"` is a separate
one-line change once the repo's open PRs are clear. The script is unit-tested
beside it: `python3 -m unittest discover -s .github/scripts -p
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

The required `check` job runs `npm run deps:audit:selftest` (local fixtures,
including a loopback registry) and `npm run deps:audit` before installing
dependencies. The audit reads every lockfile root (`package-lock.json` and
`web/package-lock.json`), includes development/optional/peer dependencies, and
blocks high, critical or unknown severity. It prints one result per lockfile
(`.` and `web`) and fails when either has a non-excepted finding. A missing
`web/package-lock.json` or an unreachable registry for either lockfile fails
closed. It forces online auditing even when npm's environment or `.npmrc`
enables offline mode, using a fresh per-lockfile cache rather than the restored
installation cache (which can retain stale advisory severity). The owned audit
caches are removed on success or failure. A child-only Node preload also validates
the exact raw bulk advisory response before npm can normalize it. A clean `{}`
is valid; `null`, arrays and missing/unknown advisory severities are not. The
preload observes bounded HTTP/HTTPS bodies (including compressed responses),
without changing registry selection, authentication or response bytes. Its
separate validation pipe contains only counters/booleans, not registry data.
Missing/incomplete validation, unsupported audit redirects/legacy quick fallback,
and a future npm transport that escapes observation fail closed. The gate requires
an observed valid bulk response, even for a lockfile with no audit candidates.
Cyclic `via` references are traversed once per reachable package, retaining every
advisory ID and blocking severity. Invalid JSON, malformed/inconsistent severity
counters, missing references, registry/process failures and invalid/expired
exceptions also fail closed.
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
**Fixed** (`fix`). `chore`, `docs`, `test`, `ci`, `build`, `refactor` and `style`
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
assertions remain unchanged. These formatter exemptions disable neither lint nor
typecheck.
Configuration options follow the [Biome configuration reference](https://biomejs.dev/reference/configuration/).

Never commit secrets, `.dev.vars` or `node_modules/`. Run tests only against the
disposable test database or local fixtures described in [README.md](README.md),
never against a production or staging database. See the README for the full
configuration reference.
