# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 335872 -> 336640 (+768, three 256 B steps) and
client JS gzip 103168 -> 103680 (+512, two 256 B steps).
Client JS raw is no longer changed: main raised it to 257024 meanwhile
(event-detail allocation) and the composition fits it with 201 B margin.
No other ceiling changes. This is the fragment-era allocation for the
join/timezone composition. Main moved repeatedly while this proposal
waited (the event-time commitment change grew the Kit server and client
bundles again), so every number below is a fresh re-measurement on the
current main, not carried forward.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Main at measurement: `7d5db1c21f12d8d51b74be43374cb7451cd31c76`. The sizes were first measured on
  `b5bef6810` and reproduced byte-for-byte on this main (the intervening
  commits change only budgets, tests and the Hono past-events island).
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
gzip wobbled 1-2 B between builds (main 335655 / 335653, composition
336465 / 336463); the larger value is used.

| Tree | Server files | Server raw B | Server gzip B | Client files | Client raw B | Client gzip B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1186502 / 1186500 | 335655 / 335653 | 54 | 255118 | 102664 |
| Composition | 116 | 1189698 / 1189698 | 336465 / 336463 | 55 | 256823 | 103459 |

Main fits every retained ceiling (server gzip 335872, client raw 257024,
client gzip 103168). Against those retained ceilings the composition breaches
server gzip by 593 B and client gzip by 291 B (gate exit 1 in both builds);
client raw (256823 of 257024) fits. Worker (2551 raw / 1219 gzip B) and client CSS
(2 files, 2861 raw / 1019 gzip B) are identical in every build and still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +795 gzip client bytes, and +3198 raw / +812 gzip server bytes:
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
| Server gzip | 336465 | 336384, short 81 B | 336640 | 175 B |
| Client gzip | 103459 | 103424, short 35 B | 103680 | 221 B |

Margins are thin by construction: each ceiling is the smallest step the
policy allows and no reserve is added. Client builds are byte-stable
across repeats, so the margins are real headroom for this exact composition
and no more; any later growth needs its own allocation.

One-byte and one-step-below controls run in the updated shipping-budget
tests: exact ceilings fit, one byte over breaches on each axis, and the
newly admitted server interval is pinned to the measured 336465 B.

## Undo

Revert only these two numeric changes (and this file): the
composition fails the restored ceilings again, main keeps passing. No
application state, schema or deployed artifact changes. Any later
integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
