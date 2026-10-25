# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 335104 -> 335872 (+768, three 256 B steps),
client JS raw 256000 -> 257024 (+1024, two 512 B steps),
client JS gzip 102912 -> 103680 (+768, three 256 B steps).
No other ceiling changes. This is the fragment-era port of the
join/timezone allocation: the monolith PR measured the same feature
delta on an older main, and a fresh re-measurement on current main
shows the composition now breaches all three byte axes, so all three
move here in the one allocation PR the task requires.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Current main: `7f1dc8c5521e2d9e1d4abfe54c0aeb8e1cfb9862`.
- Measurement tree: `2745d26d3acb1327e30df79ca255e014f9074405`
  (`git merge-tree --write-tree <behavior> <main>` reports exactly one
  conflict, the deleted-monolith modify/delete also resolved by the
  rebase; a disposable index drops the behavior-side monolith copy so
  the tree is behavior code under main's fragment budgets).
- Runtime: Node 24.22.1, npm 11.19.1. Root/web lockfiles and manifests
  are byte-identical across behavior, main and composition trees and
  match the earlier evidence hashes, so one `npm ci` serves all trees.
  No database, remote probe or deploy was used.

## Repeated results at retained limits

Two locked `npm run build --prefix web` + `npm run kit-perf` runs per
tree. Client totals are byte-identical across repeats; server gzip
wobbles 1 B, as in every prior round.

| Tree | Server files | Server raw B | Server gzip B, builds 1 / 2 | Client files | Client raw B | Client gzip B | Gate exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1182431 / 1182429 | 334842 / 334842 | 54 | 254929 | 102692 | 0 |
| Composition | 116 | 1185629 / 1185627 | 335677 / 335678 | 55 | 256634 | 103493 | 1 |

Main fits every ceiling (server gzip margin 262 B, client raw 1071 B,
client gzip 220 B). The composition breaches server gzip by 573/574 B,
client raw by 634 B and client gzip by 581 B. Worker (2551 raw /
1219 gzip B) and client CSS (2 files, 2861 raw / 1019 gzip B) are
identical in every build and still fit; bundle budgets pass on both
trees. The earlier single-axis expectation (gzip only) came from
comparing stale proposal numbers to new ceilings without rebuilding;
fresh builds falsify it, so this decision allocates the full measured
minimum instead of the stale subset.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +801 gzip client bytes, and +3198 raw / +836 gzip server
bytes: the same feature delta measured on the older main (+1705/+800
client, +3200/+830 server), riding on a grown baseline. The client
delta is one shared helper chunk plus the app entry and nodes 12/19/20
(manifest-verified: all three consumers share one implementation, no
second runtime, no new duplicate class); the server delta is admin and
detail implementation plus generated references. Full attribution is in
`docs/kit-join-investigation-timezone-union-budget.md`.

Each new ceiling is the least aligned step covering the larger observed
build, not a x1.25 reserve:

| Ceiling | Measured max | One step below (rejects) | New ceiling | Margin |
| --- | ---: | ---: | ---: | ---: |
| Server gzip | 335678 | 335616, short 62 B | 335872 | 194 B |
| Client raw | 256634 | 256512, short 122 B | 257024 | 390 B |
| Client gzip | 103493 | 103424, short 69 B | 103680 | 187 B |

One-byte and one-step-below controls run in the updated shipping-budget
tests: exact ceilings fit, one byte over breaches on each axis, and the
newly admitted server interval is pinned to the measured 335678 B.

## Undo

Revert only these three numeric changes (and this file): the
composition fails the restored ceilings again, main keeps passing. No
application state, schema or deployed artifact changes. Any later
integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
