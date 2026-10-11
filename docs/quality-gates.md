# Quality gates

Deterministic gates over reviewer judgment. New gates start WARN (report, do
not fail) unless marked HARD. All of them run on the existing runners only.

- **fetch-await (HARD):** `sg-rules/fetch-await.yml` requires every `fetch(...)`
  in `src/**` to be awaited, returned, or `.then/.catch`-chained. Fails
  `check` via `ast-grep scan --error`. Islands (`assets/islands/*.js`) are
  out of scope: they use assigned `.then` chains behind generation guards.
- **Changed-lines coverage (WARN, 80%):** `ci/patch-coverage.mjs` intersects
  the PR diff with `coverage-final.json`; added TS lines nobody executes warn.
  Aggregate floors in `vitest.config.ts` stay. Flip to `--strict` for HARD.
- **Semgrep TS + secrets (WARN):** `ci/semgrep-rules.yml` flags dangerous
  sinks (`eval`, string `setTimeout`, `innerHTML`, `document.write`) and
  secret-shaped literals. Full-history leak scanning stays with gitleaks.
- **Mutation nightly (non-blocking):** `ci/mutation-sessions-join.mjs` weakens
  one auth check at a time and runs the hermetic kill suite; survivors are
  coverage gaps in the report artifact, never a red build.
- **Test inventory (WARN):** `ci/test-inventory.mjs` fails (warns) when a
  `*.test.ts` / `*.test.mjs` file is reachable from no CI job.
- **Floor guard (HARD):** `ci/floor-guard.mjs` enforces the CONSTRAINTS.md
  floor on the PR diff: new suppressions, added skips, deleted test files,
  stripped assertions, stubs, new exception rows, and lowered thresholds fail
  `check`. Exemptions live in `.constraintsignore` (content rules only).

## Merge-blocking mutation proposal

Nightly triage (2026-10-11, head `de850cf`): 20/20 mutants killed, zero
survivors, so nothing is on fire. The blocking candidates are the seven new
targeted mutants — `R4`–`R7` (`src/roles.ts`: blank-allowlist admit,
fetch-failure admit, lookup-failure admit, any-role admits) and `W1`–`W3`
(`src/admin/validation-wall-time.ts`: fold flip, gap admitted, unknown zone
admitted) — because each is killed by a 2-file, 46-test subset
(`moderator-malformed-success` + `event-time-validation`) that runs in ~3s
DB-free. A blocking job (baseline + 7 mutants ≈ under 1 min on the existing
runners) flips these from nightly-signal to merge-blocking without moving the
slow session/join/admin mutants, which stay nightly. Not implemented yet:
needs its own PR wiring the subset job in WARN first.
