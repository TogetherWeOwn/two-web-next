# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 336384 -> 337152 (+768, three 256 B steps),
client JS raw 257024 -> 258560 (+1536, three 512 B steps),
client JS gzip 103168 -> 103936 (+768, three 256 B steps).
No other ceiling changes. This is the fragment-era allocation for the
join/timezone composition. Main moved repeatedly while this proposal
waited; the latest 2026-10-27 measurement includes the build-time
critical-CSS generation change and the 336896 server shipping-test arm.
Regenerated critical CSS is byte-identical to the preceding main.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Main at measurement: `d6e9491c2216738cf016c7020c0ea84e7a5b7f91`.
- Measurement tree: the behavior head merged into that main
  (`13161ee51cdbbc4835121bc13517b3122cdabab3`); the only
  conflict is the modify/delete of the removed monolith
  `ci/kit-perf-budget.json`, resolved by accepting the deletion, so the tree
  is behavior code under main's fragment budgets.
- Runtime: Node 24.22.1, npm 11.19.1. Root/web manifests and lockfiles and
  the canonical checker are byte-identical across both trees; one
  `npm ci --include=dev` installation per dependency root serves both.
  No database, remote probe or deploy.

## Repeated results

Two locked `npm run build --prefix web` + `node ci/check-kit-perf.mjs`
runs per tree; all four builds exit 0. Client totals are identical across
repeats; server gzip varies by 1–2 B with unchanged raw totals.

| Tree | Server files | Server raw B | Server gzip B, builds 1 / 2 | Client files | Client raw B | Client gzip B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1190240 | 336250 / 336248 | 54 | 256371 | 102994 |
| Composition | 116 | 1193438 | 337054 / 337053 | 55 | 258076 | 103790 |

Main fits every retained ceiling (server gzip 336384, client raw 257024,
client gzip 103168). The larger composition breaches server gzip by 670 B,
client raw by 1052 B and client gzip by 622 B (gate exit 1 in both builds).
Worker (2551 raw / 1219 gzip B) and client CSS (2 files, 2861 raw / 1019 gzip B)
are identical in every build and still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +796 gzip client bytes, and +3198 raw / +804 to +805 gzip server
bytes in paired builds. The client delta is one shared helper chunk plus
the app entry and nodes 12/19/20 (all three consumers share one implementation,
no second runtime); the server delta is `chunks/admin.js` (+3023 raw) plus
the detail server load (+67) and generated node references (+108).
No new duplicate-content group appears. Full attribution and the smaller
output options considered are in `docs/kit-join-investigation-timezone-union-budget.md`.

Each new ceiling is the least aligned step covering the larger observed
build, not a reserve:

| Ceiling | Measured max | One step below (rejects) | New ceiling | Margin |
| --- | ---: | ---: | ---: | ---: |
| Server gzip | 337054 | 336896, short 158 B | 337152 | 98 B |
| Client raw | 258076 | 258048, short 28 B | 258560 | 484 B |
| Client gzip | 103790 | 103680, short 110 B | 103936 | 146 B |

Margins are whatever the least step leaves; any later growth needs fresh
measurement. Nine controls on disposable budget copies freeze the second
composition output (server gzip 337053 B): retained limits reject, proposed
and exact limits accept, and one-byte/one-step-under limits reject each axis
independently. A frozen output's one-byte control is not evidence of
byte-stable rebuilds. The shipping tests retain their original 337052 B
interval fixture plus exact/one-over literals for the same 337152 B step.

## Undo

Revert the full allocation: the three numeric changes, this decision file,
the linked note and the allocation-specific pins in `ci/check-kit-perf.test.mjs`
and `ci/budget-fragments.test.mjs`, preserving unrelated main allocation arms.
The composition fails the restored ceilings again; main keeps passing. No
application state, schema or deployed artifact changes. Any later integrated
head must be freshly rebuilt and pass exact-head CI, security, QA and
independent review.
