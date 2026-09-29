# Contributing

## Commits and PRs

- Squash-merge only. Each PR is one logical change.
- PR title = Conventional Commits header: `type(scope): summary`, at most 100
  characters, no trailing period. Types: `feat`, `fix`, `perf`, `refactor`,
  `test`, `docs`, `build`, `ci`, `chore`, `revert`, `style`, `security`.
- Card ID goes in the body as `Refs: TOG-1234`, never in the title.
- PR body explains what changed, why, and how it was tested (see the PR template).
- `check`, `gitleaks` and `pr-lint` are required checks on `main`.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please)
(`release-please-config.json` + `.release-please-manifest.json`, release-type
`node`). Merge a conventional commit to `main` and release-please opens or
updates a release PR; merging that PR writes `CHANGELOG.md`, tags `vX.Y.Z`
and publishes a GitHub Release. Never tag or release by hand.

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
