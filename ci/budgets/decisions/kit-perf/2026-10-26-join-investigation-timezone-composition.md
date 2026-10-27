# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 335360 -> 336384 (+1024, four 256 B steps),
client JS raw 256000 -> 257024 (+1024, two 512 B steps),
client JS gzip 103168 -> 103424 (+256, one 256 B step).
No other ceiling changes. This is the fragment-era allocation for the
join/timezone composition. Main moved repeatedly while this proposal
waited (the client gzip and server gzip ceilings both rose on main in the
meantime), so every number below is a fresh re-measurement on the current
main, not carried forward.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Current main: `cb0f15736f603bf263be9d386dee179c3be8d4d7`.
- Measurement tree: `a11050a93dbf2beea3c103d0eaee788ec2ac0d15` (behavior
  head merged into main; the only conflict is the modify/delete of the
  removed monolith `ci/kit-perf-budget.json`, resolved by accepting the
  deletion, so the tree is behavior code under main's fragment budgets).
- Runtime: Node 24.22.1, npm 11.19.1. Root/web manifests and lockfiles and
  the canonical checker are byte-identical across both trees; one
  `npm ci --include=dev` serves both. No database, remote probe or deploy.

## Repeated results at retained limits

Two locked `npm run build --prefix web` + `node ci/check-kit-perf.mjs`
runs per tree. Client totals are byte-identical across repeats; server
gzip was identical in both builds this round (earlier rounds wobbled 1 B).

| Tree | Server files | Server raw B | Server gzip B, builds 1 / 2 | Client files | Client raw B | Client gzip B | Gate exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1185439 / 1185439 | 335349 / 335349 | 54 | 254926 | 102621 | 0 |
| Composition | 116 | 1188637 / 1188637 | 336153 / 336153 | 55 | 256631 | 103418 | 1 |

Main fits every ceiling (server gzip margin 11 B, client raw 1074 B, client
gzip 547 B). The composition breaches server gzip by 793 B, client raw by
631 B and client gzip by 250 B. Worker (2551 raw / 1219 gzip B) and client
CSS (2 files, 2861 raw / 1019 gzip B) are identical in every build and
still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +797 gzip client bytes, and +3198 raw / +804 gzip server bytes:
the same feature delta as every earlier round (+1705 client raw, +3200
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
| Server gzip | 336153 | 336128, short 25 B | 336384 | 231 B |
| Client raw | 256631 | 256512, short 119 B | 257024 | 393 B |
| Client gzip | 103418 | 103168, short 250 B | 103424 | 6 B |

The client gzip margin is deliberately thin: the 256 B step is the smallest
the policy allows and no reserve is added. Client builds are byte-stable
across repeats, so 6 B is real headroom for this exact composition but no
more; any later client growth needs its own allocation.

One-byte and one-step-below controls run in the updated shipping-budget
tests: exact ceilings fit, one byte over breaches on each axis, and the
newly admitted server interval is pinned to the measured 336153 B.

## Undo

Revert only these three numeric changes (and this file): the
composition fails the restored ceilings again, main keeps passing. No
application state, schema or deployed artifact changes. Any later
integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
