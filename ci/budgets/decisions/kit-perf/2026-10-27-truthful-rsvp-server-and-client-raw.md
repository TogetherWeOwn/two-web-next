# 2026-10-27 decision: server JS gzip 335872 -> 336384 and client JS raw 256000 -> 256512 (truthful RSVP prompts)

Two ceilings move in `ci/budgets/kit/`, each by the smallest step that fits,
and nothing else changes:

- `server-js.json`: `server.js.maxGzipBytes` 335872 -> 336384.
- `client-js.json`: `client.js.maxRawBytes` 256000 -> 256512.

The guest and non-member RSVP prompts (paused, full and join-the-server
notes) render on the server and ship in the Svelte event-detail chunk, so the
combined tree grows past both ceilings that main sits just under.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm ci --include=dev`, `npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`. Both trees are current `origin/main`
(`7b0e87592`) with and without this branch.

| Tree | Server gzip | Client raw | Client gzip | Gate |
|---|---:|---:|---:|---|
| pristine main `7b0e87592` | 335652/335872 (margin 220) | 255118/256000 (margin 882) | 102664/103168 | exit 0 |
| main + this branch, ceilings unchanged | 336151 (279 over) | 256073 (73 over) | 102882/103168 | exit 1 |
| main + this branch, ceilings above | 336151/336384 (margin 233) | 256073/256512 (margin 439) | 102882/103168 | exit 0 |

Feature delta: server +499 gzip, client +955 raw / +218 gzip. Server files
116/126 and client files 54/55 are unchanged; worker (2551/1219B) and client
CSS (2861/1019B) are byte-identical to main. Server raw 1189057/1203200B and
client gzip 102882/103168B fit unchanged ceilings. The combined tree was
built once; the main tree once.

## Why this step size

Server gzip 336128 (one 256B step) is 23B short of 336151, so 336384 is the
smallest 256B-aligned fit. Client raw 256000 + 512 = 256512 is the smallest
512B-aligned fit (margin 439B, above the 131B renaming churn). Both are far
below x1.25.

## Attribution

`src/events/kit-detail.ts` threads the boolean signed-in signal and
`web/src/lib/EventDetail.svelte` renders the new prompts from the shared
island contract copy. No new files and no dependency, workflow, checker or
mask change.

## Shipping tests

`ci/check-kit-perf.test.mjs` and `ci/budget-fragments.test.mjs` pin the shipping
ceilings and must admit these two values; that test-owned correction ships
separately and merges with this fragment step.

Exact-head CI and independent review remain mandatory. Undo: revert the two
fragment steps and this record.
