# 2026-10-27 decision: Kit ceilings for the archive game facet

Three ceilings rise, each by the smallest aligned step that covers the
measured worst case. Everything else (server raw 1203200 and 126 files,
client JS 55 files, worker, CSS, startup) is unchanged.

| Ceiling | Fragment | Old | New | Step |
|---|---|---:|---:|---:|
| client JS raw | `ci/budgets/kit/client-js.json` | 257024 | 257536 | +512 |
| client JS gzip | `ci/budgets/kit/client-js.json` | 103168 | 103424 | +256 |
| server JS gzip | `ci/budgets/kit/server-js.json` | 335872 | 337664 | +1792 |

This admits the archive game facet (public pull request for the feature:
#1774): a native game filter on the past-events archive for both route
twins, the archive-visible game suggestions read, and the filter-aware
empty states. The delta was proven minimal for the pinned acceptance
contract across repeated builds; reducing it would drop pinned behavior.
The decision was made by the CEO budget-ceiling authority; the values are
maxima for the base measured below.

## Measurements

Locked production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree.

Pristine main `cd50096f3`: client JS 54 files, raw 254926, gzip 102621;
server gzip 335335. The ceilings then in force were client 256000/103168 and
server gzip 335360.

Main kept growing while this change waited (the 335872 event-time server
allocation and the 257024 event-detail client raw ceiling both landed), so the
decision was re-measured on main `7d5db1c21`.

Feature merged with main `7d5db1c21`: client JS 55 files, raw 257376, gzip
103365 (identical in both builds); server gzip 337550 and 337552; worker
2551/1219 and CSS 2 files, 2861/1019 unchanged.

| Ceiling | Worst measured | Old ceiling | New ceiling | Margin |
|---|---:|---:|---:|---:|
| client JS raw | 257376 | 257024 | 257536 | 160 |
| client JS gzip | 103365 | 103168 | 103424 | 59 |
| server JS gzip | 337552 | 335872 | 337664 | 112 |

The next lower aligned steps (257280 raw, 103168 gzip, 337408 gzip) each
reject the measured output. Feature delta over pristine main: client
+2258 raw / +702 gzip, server +1914 gzip. Server gzip varies by +-2B across
identical-tree rebuilds; that jitter is disclosed, not signal. The CEO
approved the 337408 server maximum on the earlier base and then the
one-step 337664 maximum after main-side growth pushed the same feature delta
past it.

## Shipping tests

`ci/budget-fragments.test.mjs` moves with the ceilings (client pins plus
the admitted server allocation list). The fixed client and server
boundary literals in `ci/check-kit-perf.test.mjs` move with them (delivered
by the test owner); they are part of this change and of its rollback.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Staging and release acceptance are not claimed; exact-head CI and
independent review remain mandatory. Undo: revert the two fragment steps,
the oracle pins, the `ci/check-kit-perf.test.mjs` boundary fixtures and this
record.
