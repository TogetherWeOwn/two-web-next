# Contributing

## Commits and PRs

- Squash-merge only. Each PR is one logical change.
- PR title = Conventional Commits header: `type(scope): summary`, at most 100
  characters, no trailing period. Types: `feat`, `fix`, `perf`, `refactor`,
  `test`, `docs`, `build`, `ci`, `chore`, `revert`, `style`, `security`.
- Card ID goes in the body as `Refs: TOG-1234`, never in the title.
- PR body explains what changed, why, and how it was tested (see the PR template).
- `check`, `gitleaks` and `pr-lint` are required checks on `main`.

## Dependency security and static analysis

The required `check` job runs `npm run deps:audit:selftest` (local fixtures,
including a loopback registry) and `npm run deps:audit` before installing
dependencies. The audit reads `package-lock.json`, includes
development/optional/peer dependencies, and blocks high, critical or unknown
severity. It forces online auditing even when npm's environment or `.npmrc`
enables offline mode. Invalid JSON, malformed/inconsistent severity counters,
registry/process failures and invalid/expired exceptions also fail closed.
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

Releases are automated with [release-please](https://github.com/googleapis/release-please)
(`release-please-config.json` + `.release-please-manifest.json`, release-type
`node`). Merge a conventional commit to `main` and release-please opens or
updates a release PR; merging that PR writes `CHANGELOG.md`, tags `vX.Y.Z`
and publishes a GitHub Release. Never tag or release by hand.

`CHANGELOG.md` uses the [Common Changelog](https://common-changelog.org/)
categories, in its order: **Changed** (`perf`, `revert`), **Added** (`feat`),
**Fixed** (`fix`). `chore`, `docs`, `test`, `ci`, `build`, `refactor` and `style`
stay out of the changelog. Each squash-merged PR title becomes one entry, so
write it for a reader of the changelog: imperative mood, one user-facing change.

Versioning is SemVer, starting at `0.1.0`; `1.0.0` marks the production
cutover. `feat!` / `BREAKING CHANGE` bumps major (minor while `0.x`).

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in locally; never commit
npm run dev
npm run check                    # typecheck + tests
```

Never commit secrets, `.dev.vars` or `node_modules/`. See
[README.md](README.md) for the full configuration reference.
