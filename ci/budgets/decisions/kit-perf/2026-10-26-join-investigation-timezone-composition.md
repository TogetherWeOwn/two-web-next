# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 336384 -> 336896 (+512, two 256 B steps),
client JS raw 257024 -> 258560 (+1536, three 512 B steps),
client JS gzip 103168 -> 103936 (+768, three 256 B steps).
No other ceiling changes. This is the fragment-era allocation for the
join/timezone composition. Main moved repeatedly while this proposal
waited (event-time commitment, event-detail roster, Happening-now,
archive-search, event-share honesty and event-time-from-now work all grew
the Kit bundles and moved the ceilings), so every number below is a fresh
re-measurement on the current main, not carried forward.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Main at measurement: `d4d7a9da5b7f44c071369d376bf940c6a2e01db0`.
- Measurement tree: the behavior head merged into that main
  (`git merge-tree` tree `c82d3e12798035f482d45cf61f41bc9e74b9db40`); the only
  conflict is the modify/delete of the removed monolith
  `ci/kit-perf-budget.json`, resolved by accepting the deletion, so the tree
  is behavior code under main's fragment budgets.
- Runtime: Node 24.22.1, npm 11.19.1. Root/web manifests and lockfiles and
  the canonical checker are byte-identical across both trees; one
  `npm ci --include=dev` serves both. No database, remote probe or deploy.

## Repeated results

Two locked `npm run build --prefix web` + `node ci/check-kit-perf.mjs`
runs per tree. Client totals are byte-identical across repeats; server
gzip wobbled 2-3 B between builds (main 336044 / 336041, composition
336855 / 336853). The largest value over all builds, 336855, is used.

| Tree | Server files | Server raw B | Server gzip B | Client files | Client raw B | Client gzip B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1188729 / 1188727 | 336044 / 336041 | 54 | 256371 | 102994 |
| Composition | 116 | 1191927 / 1191925 | 336855 / 336853 | 55 | 258076 | 103790 |

Main fits every retained ceiling (server gzip 336384, client raw 257024,
client gzip 103168). Against those retained ceilings the composition breaches
server gzip by 471 B, client raw by 1052 B and client gzip by 622 B (gate
exit 1 in both builds). Worker (2551 raw / 1219 gzip B) and client CSS
(2 files, 2861 raw / 1019 gzip B) are identical in every build and still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +796 gzip client bytes, and +3198 raw / +811 gzip server bytes:
the same feature delta as every earlier round (+1705 client raw, +3198
server raw), riding on a grown baseline. The client delta is one shared
helper chunk plus the app entry and nodes 12/19/20 (all three consumers
share one implementation, no second runtime); the server delta is
`chunks/admin.js` (+3023 raw) plus the detail server load and generated
node references. Full attribution is in
`docs/kit-join-investigation-timezone-union-budget.md`.

Each new ceiling is the least aligned step covering the larger observed
build, not a reserve:

| Ceiling | Measured max | One step below (rejects) | New ceiling | Margin |
| --- | ---: | ---: | ---: | ---: |
| Server gzip | 336855 | 336640, short 215 B | 336896 | 41 B |
| Client raw | 258076 | 258048, short 28 B | 258560 | 484 B |
| Client gzip | 103790 | 103680, short 110 B | 103936 | 146 B |

Margins are whatever the least step leaves: the server margin is thin
(41 B against 2-3 B rebuild wobble) and the client raw margin is wide
(484 B, because the total lands 28 B above 258048), but each ceiling is
the smallest step the policy allows and no reserve is added. Client
builds are byte-stable across repeats, so the margins are real headroom
for this exact composition and no more; any later growth needs its own
allocation.

One-byte and one-step-below controls run in the updated shipping-budget
tests: exact ceilings fit, one byte over breaches on each axis, and the
newly admitted server interval is pinned to the measured 336855 B.

## Undo

Revert only these three numeric changes (and this file): the
composition fails the restored ceilings again, main keeps passing. No
application state, schema or deployed artifact changes. Any later
integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
