# 2026-10-27 decision: Kit ceilings for the archive game facet

Three ceilings rise, each by the smallest aligned step that covers the
measured worst case. Everything else (server raw 1203200 and 126 files,
client JS 55 files, worker, CSS, startup) is unchanged.

| Ceiling | Fragment | Old | New | Step |
|---|---|---:|---:|---:|
| client JS raw | `ci/budgets/kit/client-js.json` | 256000 | 257536 | +1536 |
| client JS gzip | `ci/budgets/kit/client-js.json` | 103168 | 103424 | +256 |
| server JS gzip | `ci/budgets/kit/server-js.json` | 335360 | 337408 | +2048 |

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
server gzip 335335 (25B under its ceiling).

Feature merged with main `4cd035fd8`: client JS 55 files, raw 257184, gzip
103323 (identical in both builds); server gzip 337248 and 337249; worker
2551/1219 and CSS 2 files, 2861/1019 unchanged.

| Ceiling | Worst measured | Old ceiling | New ceiling | Margin |
|---|---:|---:|---:|---:|
| client JS raw | 257184 | 256000 | 257536 | 352 |
| client JS gzip | 103323 | 103168 | 103424 | 101 |
| server JS gzip | 337249 | 335360 | 337408 | 159 |

The next lower aligned steps (257024 raw, 103168 gzip, 337152 gzip) each
reject the measured output. Feature delta over pristine main: client
+2258 raw / +702 gzip, server +1914 gzip. Server gzip varies by +-1B across
identical-tree rebuilds; that jitter is disclosed, not signal.

## Shipping tests

`ci/budget-fragments.test.mjs` moves with the ceilings (client pins plus
the admitted server allocation list). The fixed literals in
`ci/check-kit-perf.test.mjs` pin the old client and server ceilings by
design and are corrected separately by the test owner; this change does not
touch that file.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Staging and release acceptance are not claimed; exact-head CI and
independent review remain mandatory. Undo: revert the two fragment steps,
the oracle pins and this record.
