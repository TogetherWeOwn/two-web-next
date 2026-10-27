# 2026-10-27 decision: Kit ceilings for the archive game facet

Three ceilings rise to the approved maxima. Client raw and gzip each rise
by the smallest aligned step that covers the measured worst case; server
gzip rises one step further, per the CEO's explicit option, so the next
small main-side growth does not force a fourth decision round for this
one feature. Everything else (server raw 1203200 and 126 files, client
JS 55 files, worker, CSS, startup) is unchanged.

| Ceiling | Fragment | Old | New | Step |
|---|---|---:|---:|---:|
| client JS raw | `ci/budgets/kit/client-js.json` | 257024 | 257792 | +768 |
| client JS gzip | `ci/budgets/kit/client-js.json` | 103168 | 103680 | +512 |
| server JS gzip | `ci/budgets/kit/server-js.json` | 336128 | 337920 | +1792 |

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

Feature merged with main `e37975a07` (the archive search form #1487, the
discovery byte cap #1913 and the Happening-now server allocation #1923):
client JS 55 files, raw 257627, gzip 103443 (byte-identical in both
builds); server gzip 337641 and 337642; worker 2551/1219 and CSS 2 files,
2861/1019 unchanged. Main `227414575` (kit-perf shipping literals #1911,
tests-only) merged after the builds changes no shipped byte.

| Ceiling | Worst measured | Old ceiling | New ceiling | Margin |
|---|---:|---:|---:|---:|
| client JS raw | 257627 | 257024 | 257792 | 165 |
| client JS gzip | 103443 | 103168 | 103680 | 237 |
| server JS gzip | 337642 | 336128 | 337920 | 278 |

The next lower aligned client steps (257536 raw, 103424 gzip) each reject
the measured output, by 91B and 19B. The next-lower server step (337664)
would admit the measured output with only 22B margin; the CEO approved
337920 instead after three rounds in which main-side growth of 100-300B
kept consuming the margin. Server gzip varies by +-2B across
identical-tree rebuilds; that jitter is disclosed, not signal. Client
bytes were byte-identical before and after the #1913/#1923/#1911
landings, so this round's growth is entirely main-side.

## Shipping tests

`ci/budget-fragments.test.mjs` moves with the ceilings (client pins plus
the admitted server allocation list). The fixed client and server
boundary literals in `ci/check-kit-perf.test.mjs` move with them
(delivered by the test owner); they are part of this change and of its
rollback.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Staging and release acceptance are not claimed; exact-head CI and
independent review remain mandatory. Undo: revert the two fragment steps,
the oracle pins, the `ci/check-kit-perf.test.mjs` boundary fixtures and
this record.
