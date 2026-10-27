# 2026-10-27 decision: server JS gzip 335872 -> 336384 (truthful RSVP prompts)

One ceiling moves in `ci/budgets/kit/`, by the smallest step that fits,
and nothing else changes:

- `server-js.json`: `server.js.maxGzipBytes` 335872 -> 336384.

The guest and non-member RSVP prompts (paused, full and join-the-server
notes) render on the server, so the combined tree grows past the server
gzip ceiling that main sits just under. Client raw needs no step: main's
landed 257024 ceiling (#1895) covers the combined 256073 with 951B to
spare, superseding the earlier 256512 proposal.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm ci --include=dev`, `npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`. Both trees are current `origin/main`
(`3baeb3793`) with and without this branch, each built twice.

| Tree | Server gzip | Client raw | Client gzip | Gate |
|---|---:|---:|---:|---|
| pristine main `3baeb3793` | 335653/335654 (margin 218) | 255118/257024 | 102664/103168 | exit 0, 0 |
| main + this branch, server at 335872 | 336153 (281 over) | 256073/257024 | 102882/103168 | exit 1 |
| main + this branch, server at 336128 | 336153 (25 over) | 256073/257024 | 102882/103168 | exit 1 |
| main + this branch, server at 336384 | 336152/336153 (margin 231) | 256073/257024 | 102882/103168 | exit 0, 0 |

The middle two rows are a scratch ladder over the combined build output
(only the server ceiling varied). Server files 116/126 and client files
54/55 are unchanged counts; worker (2551/1219B) and client CSS
(2861/1019B) are byte-identical to main. Server raw 1189055/1203200B and
client gzip 102882/103168B fit unchanged ceilings.

Feature delta (worst-case builds): server +499 gzip, client +955 raw /
+218 gzip.

## Why this step size

Server gzip 336128 (one 256B step) rejects the worst-case 336153 by 25B,
so 336384 is the smallest 256B-aligned fit (margin 231B, above the ~3B
rebuild jitter). It is far below x1.25.

## Attribution

`src/events/kit-detail.ts` threads the boolean signed-in signal and
`web/src/lib/EventDetail.svelte` renders the new prompts from the shared
island contract copy. No new files and no dependency, workflow, checker
or mask change. Main's three new commits since the last measure are
budget, test, workflow and docs only.

## Shipping tests

`ci/check-kit-perf.test.mjs` and `ci/budget-fragments.test.mjs` pin the
shipping server-gzip allocations and must admit 336384; that test-owned
correction ships separately and merges with this fragment step.

Exact-head CI and independent review remain mandatory. Undo: revert the
fragment step and this record.
