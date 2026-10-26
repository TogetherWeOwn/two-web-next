# Kit schedule return: measured server gzip allowance

## Current decision

The `feat/schedule-detail-return` slice at its frozen head fits every budget
except Kit server gzip. Admit the measured growth with the smallest aligned
allowance:

| Budget field | Current main | Proposal | Increase from main | Minimum measured margin |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 334080 | 335104 | 1024 | 164 |

`ceil(334940 / 256) * 256 = 335104`. Every other numeric field, checker,
inventory, manifest, lock, constraint and test stays identical to main except
the three coevolved shipping boundary literals (exact ceiling and one-byte-over
fixture plus its diagnostic ceiling); the fixed 333639 shipping evidence stays
unchanged. No feature/runtime change is authored here. This prerequisite does
not reserve capacity or approve the feature: the parent must remeasure its
actual integrated head and pass exact-head CI and independent review.

## Pinned inputs

- Main: `91b66a68d2d37bd2c717f3a75299300d3617b811`.
- Frozen feature: `9968879992bbb023f57776b26c3feb2069f9e9c6`
  (branch `feat/schedule-detail-return`).
- Scratch composed tree: `1db090d43ab9085b1f1b89f49603a85183ba6f47`, a real
  `git merge` of the frozen feature into pinned main with zero conflicts.
  This scratch measurement does not modify or approve the parent's branch.
- Node `24.22.1`, npm `11.19.1`, root/web locked installs with
  `npm ci --include=dev`. Root lock SHA-256
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`;
  web lock SHA-256
  `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
  Both lockfiles are byte-identical between the measured trees (`cmp` clean),
  so both trees build against the same installed dependencies.
- `NODE_ENV=production` in all builds. The first build pair ran with inert
  staging/PlanetScale URL variables present; the second pair and the third
  combined build ran with them scrubbed. Outputs agree within 2 bytes, so the
  extra variables are demonstrated inert, not assumed so. Local artifacts only;
  no database, live probe, staging, migration or deploy.

## Repeated production builds

Per tree: `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`. All five builds exit 0. The
unchanged canonical checker sums individual files' default-`gzipSync` sizes;
this is not a concatenated archive or another compressor. Both pristine builds
pass main's complete budget. All three combined builds fail only server gzip.

| Tree / build | Server files / cap | Server raw / ceiling | Server gzip / main ceiling | Client raw / gzip | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| Pristine main 1 | 115 / 126 | 1178762 / 1203200 | 333875 / 334080 | 253949 / 102273 | exit 0 |
| Pristine main 2 | 115 / 126 | 1178764 / 1203200 | 333874 / 334080 | 253949 / 102273 | exit 0 |
| Combined 1 | 115 / 126 | 1182448 / 1203200 | 334938 / 334080 | 254010 / 102287 | exit 1, server gzip |
| Combined 2 | 115 / 126 | 1182448 / 1203200 | 334938 / 334080 | 254010 / 102287 | exit 1, server gzip |
| Combined 3 | 115 / 126 | 1182450 / 1203200 | 334940 / 334080 | 254010 / 102287 | exit 1, server gzip |

The maximum observed combined server gzip, 334940, selects the proposal. The
2-byte spread across combined builds is observed build variation (see repeat
identity below), not permission to ignore a breach or claim an unmeasured
churn bound.

## Actual-output negative controls

Apply each ceiling to both archived combined outputs (builds 2 and 3) and run
the unchanged checker via its real `runJson` entry point. Every other ceiling
stays at main's values; emitted artifacts stay fixed.

| Server gzip ceiling | Build 2 (334938) | Build 3 (334940) |
| ---: | --- | --- |
| 335104 (proposed) | exit 0, every group fits | exit 0, every group fits |
| 334848 (one aligned step less) | exit 1, server gzip only | exit 1, server gzip only |
| exact fit (334938 / 334940) | exit 0 | exit 0 |
| exact fit minus one byte | exit 1, server gzip only | exit 1, server gzip only |
| 334080 (restored main) | exit 1, server gzip only | exit 1, server gzip only |

**10/10** expected outcomes match exits and failing-group identities. No
smaller aligned ceiling fits either output.

Unaffected groups on the combined builds, at main's unchanged limits: Worker
entry 2551/3584 raw, 1219/1536 gzip; client JavaScript 54/55 files, 254010
raw, 102287 gzip; client CSS 2/4 files, 2833 raw, 1006 gzip; server raw
1182450/1203200 with 115/126 files. Startup remains 60000ms, **not timed**.

## Attribution and repeat identity

Versus pristine main, the combined slice adds 3686 server raw bytes and
1063–1066 server gzip bytes with no new chunk. A per-chunk split attributes
the whole raw delta and +1037 gzip bytes to `chunks/events.js`: the shared
schedule-context parser/builders, grid-origin link context and twin
continuation controls (the combined chunk contains the new `Back to schedule
results` / `Back to calendar` labels). The remaining ~13–29 gzip bytes are
cross-chunk deflate wobble, including same-size reference churn in
`chunks/site-shell.js`; no other counted chunk changes.

Within the combined repeats, 181 of 183 server files are byte-identical; only
`chunks/instance.js` and `chunks/internal.js` vary (same size, different hash),
matching the known repeat signature. All client JavaScript/CSS bytes are
identical; only the uncounted `_app/version.json` stamp differs. No asset or
file-count check is hidden.

A behavior-preserving size reduction is not available without deleting
safeguards: the growth is the bounded parser's refusal paths, the context
linkage and the continuation controls the slice exists to add. The ordinary
island budget already fits unchanged on the feature branch.

## History, scope and limitations

The `$comment` history stays byte-for-byte up to this decision's appended
record; no earlier record is edited or removed. The standalone decision tree
(main plus this budget and note, without the feature) builds and passes the
canonical checker (see the PR verification section for its exact numbers).

Two parked sibling budget PRs propose higher server gzip ceilings
(`#1786` → 335360, `#1806` → 334592); both currently conflict and neither is
merged or relied upon here. If `#1786` lands first, its ceiling absorbs the
measured 334940 and this PR reconciles to history-only; `#1806`'s ceiling
would not absorb it. If this PR lands first, the siblings reconcile upward on
their own measurements. Either order keeps exact-head enforcement.

No feature source or feature acceptance-test change ships on the decision
branch. Feature behavior, database cases, browser journeys, accessibility,
live pages, startup latency and full `npm run check` are not established by
this experiment.

ACT: raise only the server gzip ceiling to the minimum aligned measured
allowance, coevolve its shipping boundary literals and record the evidence.
WHY: three combined builds reproducibly breach only that axis while pristine
main fits, and one step less fails on both archived outputs. UNDO: revert
these scalar changes and notes if the composition is abandoned, after
remeasuring intervening main growth. The parent owns actual reintegration and
acceptance.
