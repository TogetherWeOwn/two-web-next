# Operator panel reconciliation — 2026-10-28

The existing view-only feature remains in [draft PR #1660](https://github.com/TogetherWeOwn/two-web-next/pull/1660). This report records fresh integration evidence, not merge, deployment or staging approval. Earlier screenshot and verification reports retain their original source scope.

## Main integration

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
