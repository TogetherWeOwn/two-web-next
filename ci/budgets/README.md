# Budget fragments

Performance-budget ceilings live one unit per file here, and
`ci/budget-fragments.mjs` aggregates them at CI time into the plan
objects the checkers enforce:

- `kit/*.json` — Kit ceilings for `ci/check-kit-perf.mjs`: one file per
  atomic unit (`worker._worker.js`, `server.js`, `client.js`,
  `client.css`, `startup`).
- `bundle/*.json` — served-asset ceilings for
  `ci/check-bundle-budget.mjs` and `ci/minify-assets.mjs`: one file per
  budgeted asset, named `<asset file name>.json` (for a nested asset,
  prefix its directories joined with `-`, e.g. `vendor-shared.js.json`).
- `decisions/kit-perf/`, `decisions/bundle/` — one file per ceiling
  decision, named `YYYY-MM-DD-<slug>.md`.

## Changing a ceiling

1. Measure the real build output; ceilings are measured size x1.25
   rounded up (raw to 512B, gzip to 256B) unless a decision says
   otherwise. Never relax a budget just to make CI green.
2. Edit exactly one fragment file — the one carrying your unit. A new
   served asset gets a new fragment file with exactly one entry.
3. Add one new decision file under the matching `decisions/` directory
   with the measured numbers, the old and new ceilings, and why the
   growth is justified. Never append to an existing decision file, and
   never put history in a fragment `$comment` (it stays a one-line
   pointer to this README).

Two fragments defining the same unit fail the gate closed (exit 2):
there is exactly one authority per ceiling. The `0000-legacy-history-*`
files are the frozen verbatim `$comment` history from the old monolith
files (`ci/kit-perf-budget.json`, `ci/bundle-budget.json`); do not edit
them — a sha256 test in `ci/budget-fragments.test.mjs` enforces that.

Scratch fixtures in the checker selftests may still write a legacy
single budget file into a scratch root with no `ci/budgets/` directory;
the loader reads those exactly as before. A legacy file next to a
fragment directory is ambiguous and fails closed.
