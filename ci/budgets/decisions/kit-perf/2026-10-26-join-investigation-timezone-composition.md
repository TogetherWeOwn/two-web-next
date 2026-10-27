# 2026-10-26 decision: join investigation + chosen-timezone composition

Server JS gzip 336384 -> 337408 (+1024, four 256 B steps),
client JS raw 257024 -> 258560 (+1536, three 512 B steps),
client JS gzip 103168 -> 103936 (+768, three 256 B steps).
No other ceiling changes relative to main. This is the fragment-era allocation
for the join/timezone composition. Main moved repeatedly while this proposal
waited; the latest 2026-10-27 measurement includes UTC fallback labels,
admin Past-filter reads, profile-cancel handling and main's 1280 B CSS gzip
allocation. That independent CSS allocation and its shipping pins are preserved.

## Pinned inputs

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`
  (join investigation return context, PR #1705).
- Main at measurement: `db2590d0cfc892956aa8f96f21e616fa47b6d6d2`.
- Measurement tree: the behavior head merged into that main
  (`422aca706db5f56008d3bd790ab121cbf7f14df8`); the only
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
repeats; server raw/gzip vary by 1–2 B.

| Tree | Server files | Server raw B, builds 1 / 2 | Server gzip B, builds 1 / 2 | Client files | Client raw B | Client gzip B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1190767 / 1190765 | 336372 / 336370 | 54 | 256400 | 103000 |
| Composition | 116 | 1193963 / 1193965 | 337174 / 337173 | 55 | 258105 | 103795 |

Main fits every retained ceiling (server gzip 336384, client raw 257024,
client gzip 103168); its smallest observed server margin is only 12 B.
The larger composition breaches server gzip by 790 B, client raw by 1081 B
and client gzip by 627 B (gate exit 1 in both builds). Worker (2551 raw /
1219 gzip B) and client CSS (2 files, 2861 raw / 1019 gzip B) are identical
in every build and still fit.

## Why the growth is justified, and why it is minimal

Relative to current main the composition adds one client file and
+1705 raw / +795 gzip client bytes, and +3196 / +3200 raw and +802 / +803
gzip server bytes in paired builds. The client delta is one shared helper
chunk plus the app entry and nodes 12/19/20 (all three consumers share one
implementation, no second runtime). Stable server additions are
`chunks/admin.js` (+3023 raw), the detail server load (+67) and generated
node references (+108), totaling +3198 raw; import-table churn accounts for
-2 / +2 raw around that core. No new duplicate-content group appears.
Full attribution and the inspection-only smaller-output options considered
are in `docs/kit-join-investigation-timezone-union-budget.md`. No unmeasured
optimization saving or globally minimal implementation is claimed.

Each new ceiling is the least aligned step covering the larger observed
build, not a reserve:

| Ceiling | Measured max | One step below (rejects) | New ceiling | Margin |
| --- | ---: | ---: | ---: | ---: |
| Server gzip | 337174 | 337152, short 22 B | 337408 | 234 B |
| Client raw | 258105 | 258048, short 57 B | 258560 | 455 B |
| Client gzip | 103795 | 103680, short 115 B | 103936 | 141 B |

The prior unmerged 337152 B server proposal no longer covers the composition;
one more 256 B step is necessary. Margins are whatever the least step leaves;
any later growth needs fresh measurement. Ten disposable-budget controls
freeze the second composition output (server gzip 337173 B): retained limits
and the prior proposal reject, proposed and exact limits accept, and
one-byte/one-step-under limits reject each axis independently. A frozen
output's one-byte control is not evidence of byte-stable rebuilds.
Shipping server literals follow the 337408 B step; the existing client
interval fixtures still cover the unchanged client steps.

## Undo

Revert the full allocation: the three numeric changes, this decision file,
the linked note and the allocation-specific pins in `ci/check-kit-perf.test.mjs`
and `ci/budget-fragments.test.mjs`, preserving unrelated main allocation arms
including CSS gzip 1280 B. The composition fails the restored ceilings again;
main keeps passing. No application state, schema or deployed artifact changes.
Any later integrated head must be freshly rebuilt and pass exact-head CI,
security, QA and independent review.
