# 2026-10-27 decision: server JS gzip 336128 -> 336384 (truthful RSVP prompts)

One ceiling moves in `ci/budgets/kit/`, by the smallest step that fits,
and nothing else changes:

- `server-js.json`: `server.js.maxGzipBytes` 336128 -> 336384.

Main's base is the landed 336128 ceiling (Happening-now #1923). The
guest and non-member RSVP prompts (paused, full and join-the-server
notes) render on the server, so the combined tree grows past it. Client
raw needs no step: main's landed 257024 ceiling (#1895) covers the
combined 256587 with 437B to spare.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm ci --include=dev`, `npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`. The combined tree is current `origin/main`
(`5919f44c4`) with this branch, built twice.

| Tree | Server gzip | Client raw | Client gzip | Gate |
|---|---:|---:|---:|---|
| pristine main `3baeb3793` (pre-archive) | 335653/335654 | 255118/257024 | 102664/103168 | exit 0, 0 |
| main + this branch, server at 335872 | 336328 (456 over) | 256587/257024 | 103065/103168 | exit 1 |
| main + this branch, server at 336128 | 336328 (200 over) | 256587/257024 | 103065/103168 | exit 1 |
| main + this branch, server at 336384 | 336328/336328 (margin 56) | 256587/257024 | 103065/103168 | exit 0, 0 |

The middle two rows are a scratch ladder over the combined build output
(only the server ceiling varied); server gzip is byte-identical across
both builds. Server files 116/126 and client files 54/55 are unchanged
counts; worker (2551/1219B) and client CSS (2861/1019B) are
byte-identical. Server raw 1189955/1203200B fits its unchanged ceiling.
The archive-search slice (#1487) co-landed on main during this branch
and contributes ~177B of the combined server gzip; its own bytes are
recorded in its decision file.

## Why this step size

Server gzip 336128 rejects the worst-case 336328 by 200B, so 336384 is
the smallest 256B-aligned fit (margin 56B, above the ~3B rebuild
jitter). It is far below x1.25.

## Attribution

`src/events/kit-detail.ts` threads the boolean signed-in signal and
`web/src/lib/EventDetail.svelte` renders the new prompts from the shared
island contract copy. No new files and no dependency, workflow, checker
or mask change from this branch.

## Shipping tests

`ci/check-kit-perf.test.mjs` and `ci/budget-fragments.test.mjs` admit
336384 alongside main's 336128 (union merge; each side byte-identical to
its source). The 336384 interval witness 336153 predates the archive
slice and stays valid: it sits inside (336128, 336384].

Exact-head CI and independent review remain mandatory. Undo: revert the
fragment step and this record.
