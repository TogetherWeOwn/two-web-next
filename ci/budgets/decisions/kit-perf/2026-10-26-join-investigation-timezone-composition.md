# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 336128 -> 336896 (+768, three 256 B steps),
client JS raw 257024 -> 257536 (+512, one 512 B step),
client JS gzip 103168 -> 103680 (+512, two 256 B steps).
No other ceiling changes. This is the fragment-era allocation for the
join/timezone composition. Main moved repeatedly while this proposal
waited (event-time commitment, event-detail roster, Happening-now and
archive-search work all grew the Kit bundles and moved the ceilings), so
every number below is a fresh re-measurement on the current main, not
carried forward.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Main at measurement: `5919f44c4ab860c00e2d5d953ec0d8b1f79a9b0f`.
- Measurement tree: the behavior head merged into that main; the only
  conflict is the modify/delete of the removed monolith
  `ci/kit-perf-budget.json`, resolved by accepting the deletion, so the tree
  is behavior code under main's fragment budgets.
- Runtime: Node 24.22.1, npm 11.19.1. Root/web manifests and lockfiles and
  the canonical checker are byte-identical across both trees; one
  `npm ci --include=dev` serves both. No database, remote probe or deploy.

## Repeated results

Two locked `npm run build --prefix web` + `node ci/check-kit-perf.mjs`
runs per tree. Client totals are byte-identical across repeats; server
gzip wobbled 1-2 B between builds (main 335838 / 335837, composition
336646 / 336644); the larger value is used.

| Tree | Server files | Server raw B | Server gzip B | Client files | Client raw B | Client gzip B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1187398 / 1187400 | 335838 / 335837 | 54 | 255632 | 102846 |
| Composition | 116 | 1190596 / 1190598 | 336646 / 336644 | 55 | 257337 | 103642 |

Main fits every retained ceiling (server gzip 336128, client raw 257024,
client gzip 103168). Against those retained ceilings the composition breaches
server gzip by 518 B, client raw by 313 B and client gzip by 474 B (gate
exit 1 in both builds). Worker (2551 raw / 1219 gzip B) and client CSS
(2 files, 2861 raw / 1019 gzip B) are identical in every build and still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +796 gzip client bytes, and +3198 raw / +808 gzip server bytes:
the same feature delta as every earlier round (+1705 client raw, +3198
server raw), riding on a grown baseline. The client delta is one shared
helper chunk plus the app entry and nodes 12/19/20 (all three consumers
share one implementation, no second runtime); the server delta is
`chunks/admin.js` (+3023 raw) plus the detail server load and generated
node references. Full attribution is in
`docs/kit-join-investigation-timezone-union-budget.md`.

Each new ceiling is the least aligned step covering the larger observed
build, not a x1.25 reserve:

| Ceiling | Measured max | One step below (rejects) | New ceiling | Margin |
| --- | ---: | ---: | ---: | ---: |
| Server gzip | 336646 | 336640, short 6 B | 336896 | 250 B |
| Client raw | 257337 | 257024, short 313 B | 257536 | 199 B |
| Client gzip | 103642 | 103424, short 218 B | 103680 | 38 B |

Margins are thin by construction: each ceiling is the smallest step the
policy allows and no reserve is added. Client builds are byte-stable
across repeats, so the margins are real headroom for this exact composition
and no more; any later growth needs its own allocation.

One-byte and one-step-below controls run in the updated shipping-budget
tests: exact ceilings fit, one byte over breaches on each axis, and the
newly admitted server interval is pinned to the measured 336646 B.

## Undo

Revert only these three numeric changes (and this file): the
composition fails the restored ceilings again, main keeps passing. No
application state, schema or deployed artifact changes. Any later
integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
