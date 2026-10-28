# 2026-10-28 decision: server JS gzip ceiling 336640 -> 336896

`server.js.maxGzipBytes` rises 336640 -> 336896 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
featured-list unpublish row action (PR #1869): a moderator-only POST that sets
only `isPublished=false` without revalidating unrelated stored fields, plus the
Unpublish button on currently-published rows in both the Hono and Kit
inventories. One 256B step, the smallest aligned cover for the measured worst
case: 336640 rejects the combined tree by 161B.

The supported-allocation literal for 336896 already exists in
`ci/check-kit-perf.test.mjs` (bounded-reads allocation, interval 336673), so
no change accompanies this raise there. `ci/budget-fragments.test.mjs` gains
the 336896 allocation with its admit/reject pins.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm ci --include=dev` in root and web, `npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`, two builds per tree. Worst
case governs.

Pristine main tip `def3274b3`:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336640 |
|---|---:|---:|---:|---|
| 1 | 116 | 1192342 | 336634 | exit 0, margin 6 |
| 2 | 116 | 1192344 | 336634 | exit 0, margin 6 |

Feature merged onto the same main tip (scratch merge `21cb245d9` and the
equivalent feature-branch merge, PR head `9e78ef15` plus main):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336640 | Gate at 336896 |
|---|---:|---:|---:|---|---|
| 1 | 116 | 1194064 | 336800 | exit 1, 160 over | exit 0, margin 96 |
| 2 | 116 | 1194062 | 336799 | exit 1, 159 over | exit 0, margin 97 |
| 3 | 116 | 1194062 | 336801 | exit 1, 161 over | exit 0, margin 95 |
| 4 | 116 | 1194062 | 336799 | exit 1, 159 over | exit 0, margin 97 |

Feature delta on the server total is +1720 raw / +167 gzip bytes (feature
worst minus pristine worst). The current 336640 ceiling rejects the combined
tree by 161B; 336896 (256 x 1316) admits it with 95B of margin and passes the
checker (exit 0). Identical-tree jitter of 3B gzip / 2B raw is included in
the recorded range, not hidden.

Worker (2551 raw / 1219 gzip), client CSS (2861 raw / 1019 gzip) and file
counts are unchanged. Client JS grows 256819 raw / 103102 gzip to 257102 raw
/ 103192 gzip (+283 / +90) and still fits its unchanged 258048 / 103424
ceilings. Server raw/file limits and the startup ceiling do not change.

## Why the growth is justified

There is no fast way to pull a featured slot today: the list has no row
action and the only unpublish path is the full edit POST, which revalidates
every stored field. An unrelated stale field (for example an image host no
longer allowlisted) 422s and the slot stays live. That is an
incident-response gap when a slot must come down now.

The cost is one bounded POST route alongside the existing delete action
(body-capped, throttled, canonical ID, generic 404, 303 redirect, dirty-only
audit, homepage guest-cache retirement) and the row button in both list
twins. No new dependency, island, query, ordering, window or eligibility
logic; the full edit form and its validation stay byte-identical. The only
cheaper alternative is to drop the behaviour the change exists to deliver.

Sibling PRs that also edit this line re-measure on the new main. Undo:
revert this fragment step, the test allocation and this record.
