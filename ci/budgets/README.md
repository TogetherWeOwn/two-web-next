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

1. Measure the real build output (locked build, two builds, worst case
   governs). Never relax a budget just to make CI green.
2. Edit exactly one fragment file — the one carrying your unit. A new
   served asset gets a new fragment file with exactly one entry.
3. Add one new decision file under the matching `decisions/` directory
   with the measured numbers, the old and new ceilings, and why the
   growth is justified. Never append to an existing decision file, and
   never put history in a fragment `$comment` (it stays a one-line
   pointer to this README).
4. For every Kit ceiling you changed, put one machine-readable line in
   that decision file (`decisions/kit-perf/` only):
   `Ceiling: server.js.maxGzipBytes = 335616 (previous 335360)`. The key
   is the fragment path joined with dots; `(previous N)` names the
   ceiling you replaced. Decision files are read in file-name order and
   the last declaration for a key wins. `ci/budget-ledger.mjs` is
   fail-closed: a fragment value with no matching declaration, or a
   declaration no fragment carries, fails `ci/budget-fragments.test.mjs`
   and `ci/check-kit-perf.test.mjs`. Those shipping tests derive their
   cap, cap+1 and newly-allowed-interval rows from the fragment plus this
   line, so a ceiling change never edits a test literal.

## Allocation policy: block steps (2026-10-27)

Raise a Kit ceiling in a block, not in the smallest aligned cover. The
old 256B cover left 22-151B of margin, so the next feature outgrew it
within days and each growth cost a budget PR (12 of the last 25 merges).
Round the measured worst case up to the next block that leaves at least
the block size's worth of room above it:

- `server.js` gzip: 2048B blocks (the bundle moves most).
- `server.js` raw and `client.js` raw/gzip, `client.css`, worker: 1024B
  blocks (raw ceilings keep their 512B alignment as a lower bound).
- File counts and startup: unchanged; raise by the smallest step that
  fits.

The block still needs its measurements and a decision file; it is not a
x1.25 allowance, and exceeding it needs a new decision. Existing ceilings
stay as they are until their next raise.

Two fragments defining the same unit fail the gate closed (exit 2):
there is exactly one authority per ceiling. The `0000-legacy-history-*`
files are the frozen verbatim `$comment` history from the old monolith
files (`ci/kit-perf-budget.json`, `ci/bundle-budget.json`); do not edit
them — a sha256 test in `ci/budget-fragments.test.mjs` enforces that.

Scratch fixtures in the checker selftests may still write a legacy
single budget file into a scratch root with no `ci/budgets/` directory;
the loader reads those exactly as before. A legacy file next to a
fragment directory is ambiguous and fails closed.
