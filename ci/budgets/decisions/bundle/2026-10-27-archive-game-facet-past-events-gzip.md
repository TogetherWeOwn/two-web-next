# 2026-10-27 decision: past-events.js gzip ceiling for the archive game facet

One ceiling rises by the smallest aligned step that covers the measured
output. Raw stays 5120.

| Ceiling | Fragment | Old | New | Step |
|---|---|---:|---:|---:|
| `public/islands/past-events.js` gzip | `ci/budgets/bundle/past-events.js.json` | 2048 | 2304 | +256 |

This admits the archive game facet's island cost (public pull request for
the feature: #1774) on top of the discovery byte-cap slice (#1913), which
sized this island's ceilings at 5120/2048 for its own 4918/1991 bytes and
left only 57B of gzip margin.

## Measurements

Minified served asset (`npm run build:assets`), measured through
`node ci/check-bundle-budget.mjs`.

Feature merged with main `e37975a07`: `public/islands/past-events.js`
5070 raw / 2064 gzip. Raw fits 5120 with 50B margin; gzip exceeds 2048
by 16B.

| Ceiling | Measured | Old ceiling | New ceiling | Margin |
|---|---:|---:|---:|---:|
| raw | 5070 | 5120 | 5120 | 50 |
| gzip | 2064 | 2048 | 2304 | 240 |

The island delta over the byte-cap base is +152 raw / +73 gzip: five
load-bearing lines carrying the `game` query param (URL builder, param
guard admission, dataset read-through, dataset persist, canonical
compare). Shrinking it would drop pinned acceptance behavior. Every other
served asset fits its current ceiling, including `attendees-live.js`
(5050/5120 raw, 1953/2048 gzip), which this feature also touches.

## Shipping tests

`ci/budget-fragments.test.mjs` moves with the ceiling (the
`SHIPPING_BUNDLE_BUDGETS` pin for this asset). No fixed boundary literals
exist for bundle units. The decision was made by the CEO budget-ceiling
authority.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Staging and release acceptance are not claimed; exact-head CI and
independent review remain mandatory. Undo: revert the fragment step, the
oracle pin and this record.
