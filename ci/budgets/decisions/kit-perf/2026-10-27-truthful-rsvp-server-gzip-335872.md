# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872 (truthful RSVP prompts)

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
server-side render of the guest and non-member RSVP prompts (paused, full and
join-the-server notes in the event-detail route), which grows the Kit server
bundle past the current ceiling. 335872 is the allocation
`ci/check-kit-perf.test.mjs` already supports (interval 335624, exact
335872, one byte over 335873); it is the smallest supported value that covers
the measured worst case.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through `node ci/check-kit-perf.mjs`.

| Tree | Builds | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---:|---|
| main `d781cb070` | 1 | 116 | 1185177 | 335336 | exit 0, margin 24 |
| feature merged onto main `d781cb070` | 2 (byte-identical) | 116 | 1187732 | 335833 | exit 1, 473 over |

Feature delta on the server total: +2555 raw / +497 gzip bytes. The combined
tree fits at 335872 with 39B of margin. Worker (2551/1219B) and client CSS
(2 files, 2861/1019B) are byte-identical to main. Client JS grows to 54 files,
255881/102831B and fits its unchanged ceilings (256000/103168B, margins
119B raw / 337B gzip), so no client ceiling moves. Main was measured once;
the combined tree twice with identical output.

## Attribution

The growth is the prompt server render: `src/events/kit-detail.ts` threads the
boolean signed-in signal and `web/src/lib/EventDetail.svelte` renders the new
prompts from the shared island contract copy. No new files (116 server files
before and after) and no dependency, workflow, checker or mask change.

## Shipping tests

`ci/check-kit-perf.test.mjs` already pins 335872. `ci/budget-fragments.test.mjs`
admits only 335104 and 335360 and must add 335872 to its allocation list; that
test-owned correction ships separately and merges with this fragment step.

Exact-head CI and independent review remain mandatory. Undo: revert this
fragment step and this record.
