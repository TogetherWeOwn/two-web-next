# Operator panel reconciliation — 2026-10-28

The existing view-only feature remains in [draft PR #1660](https://github.com/TogetherWeOwn/two-web-next/pull/1660). This report records fresh integration evidence, not merge, deployment or staging approval. Earlier screenshot and verification reports retain their original source scope.

## Recovery after the source-reduction merge

The managed GitHub read initially failed with `broker_transport_unavailable`; one same-path retry succeeded. No alternate credential or authentication setup was used. GitHub still reported draft PR #1660 as `DIRTY` at `9668ac6c7`. The preserved `ae5b7ecd4` reconciliation had not reached the public branch.

Main now contains [source-reduction PR #1962](https://github.com/TogetherWeOwn/two-web-next/pull/1962), commit `17c3de4a1571c0315469c3f0e58a830fdd766c85`. Its automatic merge into the saved feature required no manual file resolution. A fresh locked production Kit build of this composition passes every unchanged axis: server JS 1,198,130 raw / **335,491 gzip B**, 116 files; client JS 255,918 raw / 102,519 gzip B, 53 files; client CSS 2,861 raw / 1,019 gzip B; Worker entry 2,551 raw / 1,219 gzip B. The server-gzip ceiling remains **336,896 B**. The old breach below is historical: no size-budget raise is needed or applied to this composition.

The unchanged four-suite acceptance command passes **159/159**, zero skips. Lint, typecheck, floor guard, asset synchronization and served-asset budgets pass. All 54 existing main budget/history files remain byte-identical. Both panel/transport acceptance files and both shared budget-oracle suites are unchanged. Dependencies were restored from the lockfiles into run-owned scratch, outside the synced tree.

`node --test ci/budget-fragments.test.mjs` still exits 1: **35 pass / 1 fail**, because the exact shipping table omits this feature's new stylesheet. The independently authored one-line correction remains unincorporated: [active policy PR #1924](https://github.com/TogetherWeOwn/two-web-next/pull/1924) is replacing that table and changing the new-asset allocation contract. Do not concurrently edit its shared-policy surface, open a companion PR or pretend its proposed policy has merged. Resolve landing order with the existing policy owner before consuming the correction or its replacement.

The complete project check, fresh browser/a11y/Lighthouse runs, exact ready-head CI, independent review and staging verification remain outstanding. Earlier visual evidence keeps its original source scope. This recovery changes no panel behavior, admission boundary, credential, deployment or production state.

## Main integration (earlier checkpoint)

GitHub reported a real merge conflict against main `728b70054b50623e921ee8da1c8ad92132772a15`. The only manual resolution preserves both route-inventory rows: main's featured-slot unpublish action and this feature's local operator-method refusal. The resulting 115-row inventory is the exact, duplicate-free union of the two inputs. All 54 existing main budget/history files and both shared shipping-oracle files remain byte-identical to main. The original panel and transport acceptance files remain byte-identical to the saved feature head.

The panel source and its bearer/read-only/security boundaries were not redesigned. The separately authored one-line stylesheet-oracle correction is preserved, but not incorporated in this reconciliation: [PR #1924](https://github.com/TogetherWeOwn/two-web-next/pull/1924) is already changing that shared policy surface. No new capacity, oracle, or test companion PR is opened.

## Fresh locked measurements

Node v24.22.1, pinned root and Kit lockfiles, development dependencies installed outside the source tree. Each tree received two canonical production builds with `NODE_ENV` unset:

```sh
npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

| Group | Untouched main, two builds | Integrated panel, two builds | Existing ceiling |
| --- | --- | --- | --- |
| Server JS gzip sum | 336800 / 336801 B | 338296 / 338298 B | 336896 B |
| Client JS raw / gzip | 257102 / 103192 B | unchanged | 258048 / 103424 B |
| Client CSS raw / gzip | 2861 / 1019 B | unchanged | 3072 / 1280 B |
| Worker entry raw / gzip | 2551 / 1219 B | unchanged | 3584 / 1536 B |

Untouched main passes. The integrated panel fails the server-gzip gate by up to **1402 B**; the observed feature delta is approximately **1497 B**. The added panel renderer is retained in the existing Hono admin server chunk. Its imports reuse the existing admin shell, bounded HTTP reader and constant-time bearer matcher; this feature adds no browser dependency.

The old closed capacity proposal of 338176 B would still reject the current worst build by 122 B. A hypothetical 338432 B ceiling would add 1536 B (0.456%) to current main and leave 134 B observed margin, but **no such increase is applied or approved by this report**. The shared-policy work and [existing source-reduction PR #1962](https://github.com/TogetherWeOwn/two-web-next/pull/1962) are not landed capacity and cannot be counted as current headroom.

## Verification executed

- Original panel, transport, page-shell and route-inventory helper suites: **159 passed, zero failures/skips**. The panel and transport subset remains 83 cases.
- `npm run lint`, `npm run typecheck`, `npm run build:assets:check`, `npm run budget` and `npm run floor-guard`: passed. No existing threshold changed.
- `npm run config:check`: 34 selftests passed. `npm run docs:links`: 12 citation cases plus the documentation link check passed before this report was added.
- `npm run test:inventory -- --strict`: 1295/1295 test files and 56/56 Playwright specs reachable.
- `context-pack --base origin/main`: executed. The optional shell arguments and optional Env binding preserve existing callers; mounted acceptance exercises the private parser/reader/renderer helpers. Generic name-only `fetch`, `server`, `report`, and `coverage` matches do not identify additional changed call sites. Main's unrelated changes are preserved, not reimplemented.

The complete `npm run check`, fresh browser/a11y/Lighthouse runs, visual-baseline comparisons, ready-head CI, independent 5/5 review and staging verification have **not** been completed for this reconciliation. The server budget is red; this draft is not ready for merge. No credential, deployment, production probe, mutating probe, baseline rewrite or security waiver is part of this work.
