# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
per-leaf share descriptions (PR #1927), whose static description module
grows the Kit server bundle past the current ceiling once merged with
current main. One 256B step, the smallest aligned cover for the measured
worst case: 335616 rejects it by 225B.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `ba58281d2`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185441 | 335353 | exit 0, margin 7 |
| 2 | 116 | 1185439 | 335351 | exit 0, margin 9 |

Combined tree (PR #1927 head `23db32d9a31c`, whose base is the main tip
above, so it is main plus the feature with no drift):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186786 | 335838 | exit 1, 478 over |
| 2 | 116 | 1186786 | 335838 | exit 1, 478 over |

CI on the same head measured gzip 335841 (run 40466082331), 3B above the
local worst and inside rebuild jitter. Worst case overall is therefore
335841: the current 335360 ceiling rejects it by 481B, 335616 rejects it
by 225B, and 335872 (256 x 1312) admits it with 31B of margin. Worker
(2551/1219B), client JS (55 files, 255736/103077B) and client CSS
(2 files, 2861/1019B) fit their unchanged ceilings, and the file count
stays 116 on the server side. The feature delta on the server total is
+1345 raw / +487 gzip bytes locally (combined worst minus pristine worst),
+490 gzip against CI's own pristine reading.

Rebuild jitter is disclosed, not signal: pristine gzip wobbles 2B across
rebuilds, combined builds were byte-equal locally.

## Attribution

`src/leaf-descriptions.ts` is the only new module. In the built server
output its four description sentences exist once, in `chunks/admin.js`
(the Hono `Leaf` import in `src/page-shell.tsx` pulls the module into the
admin-bundled Hono app); each of the four leaf page server entries
(`about`, `faq`, `rules`, `privacy`) imports `LEAF_DESCRIPTIONS` from that
chunk and adds a `description:` argument to its `Shell` call. No new server
file ships, and nothing from the module lands in `chunks/src.js`.

## Shipping tests

335872 already has explicit support in `ci/check-kit-perf.test.mjs`
(`SHIPPING_SERVER_GZIP_ALLOCATIONS` plus the interval 335624, exact 335872
and one-byte-over 335873 literals), so that suite needs no change. In
`ci/budget-fragments.test.mjs` the `SHIPPING_KIT_BUDGET` pin moves to the
new ceiling, 335872 joins the admitted allocation list, and a case admits it
while 335616 and 335873 stay rejected.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Sibling open PRs that also edit this line (#1905, #1929) were not
merged at measurement time; whichever lands second re-measures on the new
main. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
