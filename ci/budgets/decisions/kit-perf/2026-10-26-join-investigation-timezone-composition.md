# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 336384 -> 337152 (+768, three 256 B steps),
client JS raw 257024 -> 258560 (+1536, three 512 B steps),
client JS gzip 103168 -> 103936 (+768, three 256 B steps).
No other ceiling changes. This is the fragment-era allocation for the
join/timezone composition. Main moved repeatedly while this proposal
waited (event-time commitment, event-detail roster, Happening-now,
archive-search, event-share honesty, event-time-from-now and jobs ledger
work all grew the Kit bundles and moved the ceilings), so every number
below is a fresh re-measurement on the current main, not carried forward.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Main at measurement: `4e90a8bcfd70a46564f6bb363e1543304ec271c0`.
- Measurement tree: the behavior head merged into that main
  (`git merge-tree` tree `8021725662f02c7edd0b9b16515a7075785bc832`); the only
  conflict is the modify/delete of the removed monolith
  `ci/kit-perf-budget.json`, resolved by accepting the deletion, so the tree
  is behavior code under main's fragment budgets.
- Runtime: Node 24.22.1, npm 11.19.1. Root/web manifests and lockfiles and
  the canonical checker are byte-identical across both trees; one
  `npm ci --include=dev` serves both. No database, remote probe or deploy.

## Repeated results

Two locked `npm run build --prefix web` + `node ci/check-kit-perf.mjs`
runs per tree. Client totals and server gzip are byte-identical across
repeats; server raw wobbled 2 B between builds (main 1190242 / 1190240,
composition 1193438 / 1193440).

| Tree | Server files | Server raw B | Server gzip B | Client files | Client raw B | Client gzip B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1190242 / 1190240 | 336248 | 54 | 256371 | 102994 |
| Composition | 116 | 1193438 / 1193440 | 337052 | 55 | 258076 | 103790 |

Main fits every retained ceiling (server gzip 336384, client raw 257024,
client gzip 103168). Against those retained ceilings the composition breaches
server gzip by 668 B, client raw by 1052 B and client gzip by 622 B (gate
exit 1 in both builds). Worker (2551 raw / 1219 gzip B) and client CSS
(2 files, 2861 raw / 1019 gzip B) are identical in every build and still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +796 gzip client bytes, and +3196 raw / +804 gzip server bytes:
the same feature delta as every earlier round (+1705 client raw, +3198
server raw within 2 B of churn), riding on a grown baseline. The client
delta is one shared helper chunk plus the app entry and nodes 12/19/20
(all three consumers share one implementation, no second runtime); the
server delta is `chunks/admin.js` (+3023 raw) plus the detail server load
and generated node references. Full attribution is in
`docs/kit-join-investigation-timezone-union-budget.md`.

Each new ceiling is the least aligned step covering the larger observed
build, not a reserve:

| Ceiling | Measured max | One step below (rejects) | New ceiling | Margin |
| --- | ---: | ---: | ---: | ---: |
| Server gzip | 337052 | 336896, short 156 B | 337152 | 100 B |
| Client raw | 258076 | 258048, short 28 B | 258560 | 484 B |
| Client gzip | 103790 | 103680, short 110 B | 103936 | 146 B |

Margins are whatever the least step leaves: each ceiling is the smallest
step the policy allows and no reserve is added. Builds are byte-stable
across repeats on every axis except server raw (2 B wobble, no ceiling
impact), so the margins are real headroom for this exact composition and
no more; any later growth needs its own allocation.

One-byte and one-step-below controls run in the updated shipping-budget
tests: exact ceilings fit, one byte over breaches on each axis, and the
newly admitted server interval is pinned to the measured 337052 B.

## Undo

Revert only these three numeric changes (and this file): the
composition fails the restored ceilings again, main keeps passing. No
application state, schema or deployed artifact changes. Any later
integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
