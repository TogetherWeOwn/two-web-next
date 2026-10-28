# 2026-10-28 decision: server JS gzip ceiling 336896 -> 337152

This feature PR (#1907) admits one 256B server-gzip step after rebuilding
on main `728b70054b50623e921ee8da1c8ad92132772a15`. The shared schedule
renderers and Hono/Kit detail snapshot add the ongoing-night verdict and
badge, plus the reviewed historical-grid and Discord-spillover corrections.
The combined build exceeds the base ceiling by 140B. This is the smallest
aligned step that covers it, inside the feature PR rather than a separate
budget change.

## Measurements

Node 24.21.0 / npm 11.19.0, committed root and web lockfiles:
`npm run build --prefix web` followed by `npm run kit-perf`.

| Tree | Server files | Raw bytes | Gzip bytes | Ceiling and result |
|---|---:|---:|---:|---|
| Pristine current main | 116 | 1194064 | 336799 | 336896: passes by 97B |
| Rebuilt feature, build 1 | 116 | not recorded | 337035 | 336896: exceeds by 139B |
| Rebuilt feature, build 2 | 116 | 1195425 | 337036 | 337152: passes by 116B |

The worst measured feature delta is +1361 raw / +237 gzip bytes. The 1B
rebuild jitter is disclosed; the checker is deterministic for one artifact
set. Exact-head and merge-queue CI still decide whether the merged build
fits. Re-measure after any base or build-input change.

An earlier unpublished candidate on main `789e8a66` measured 336868/336867B
under a proposed 336896B allocation. While that candidate was being tested,
#1869 landed and independently admitted 336896B. This record replaces that
candidate's proposed step after a fresh rebase and measurements; it does
not stack two new admissions in this PR.

Worker entry remains 2551 raw / 1219 gzip bytes. Client JS is 54 files at
257316 raw / 103254 gzip bytes, versus the current base's 257102 / 103192;
its existing 258048 / 103424 ceilings still hold. Client CSS is unchanged
at 2 files and 2861 raw / 1019 gzip bytes. No client-clock island, polling,
stylesheet, query, dependency, raw/file-count cap, startup ceiling, or
user-facing Lighthouse/a11y target changes.

## Bounded admission and tests

This step is 0.0760% of the current 336896B ceiling. Including the earlier
256B admission for this same feature in #1923 (335872 -> 336128), aggregate
admission attributable to #1907 is 512B, or 0.1524% of 335872B, below the
0.5% per-feature limit. Start-of-week main commit `2f9e60791d27` had a
334080B server-gzip ceiling; 337152B is +3072B (0.9195%), below the 2% weekly
limit. Keep normal merge-queue ordering.

The shipping-fragment oracle admits only the additional explicit 337152B
allocation and adds a 337153B rejection without removing any existing
rejection. The budget checker gains fixed literals for the measured 337035B
interval, exact 337152B ceiling, and 337153B one-byte-over breach, including
JSON receipt controls. Every other plan axis stays pinned. The new
allocation test failed before the admission was added.

Undo: revert this feature PR, including this fragment step and its admission
controls. No runtime target, scanner, coverage floor, required check, or test
skip is relaxed.
