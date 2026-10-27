# Current-main reintegration evidence

Date: 2026-10-25. Before: main `d01519a8f`. After: the correlation feature integrated with that main, including the new hotzones and member-board error boundaries. These are local fixture renders, not staging evidence.

## Design contract

Reuse the [existing contract](../README.md#design-contract), the current ErrorShell/AdminShell and Hono support-reference wording. Members need the served reference when hotzones or the member board fails; moderators need both the reference and the existing failed-read retry link. Keep current typography, Open Lobby tokens, layout and responsive behavior. No CSS, framework, hydration, session/database reads, telemetry or visual baselines change. Preserve the route-specific 400/404 recovery branches.

## Visual evidence

The real Svelte boundaries are compiled for SSR with synthetic page state. Before sources come from main; after sources come from the integrated tree. Both use the same current built Kit CSS and public assets. Chromium intercepts all requests with local bytes. Desktop is 1280×800; mobile is 390×844; captures are full-page.

| State | Desktop before / after | Mobile before / after |
| --- | --- | --- |
| Hotzones 503 | [Before](before-hotzones503-desktop.png) / [After](after-hotzones503-desktop.png) | [Before](before-hotzones503-mobile.png) / [After](after-hotzones503-mobile.png) |
| Member board 503 | [Before](before-board503-desktop.png) / [After](after-board503-desktop.png) | [Before](before-board503-mobile.png) / [After](after-board503-mobile.png) |
| Admin 503 | [Before](before-admin503-desktop.png) / [After](after-admin503-desktop.png) | [Before](before-admin503-mobile.png) / [After](after-admin503-mobile.png) |
| Join-attempts 503 | [Before](before-join503-desktop.png) / [After](after-join503-desktop.png) | [Before](before-join503-mobile.png) / [After](after-join503-mobile.png) |
| Hotzones, absent id | [After](after-hotzones-blank-desktop.png) | [After](after-hotzones-blank-mobile.png) |
| Member board, absent id | [After](after-board-blank-desktop.png) | [After](after-board-blank-mobile.png) |

All 20 PNGs were opened. The reference is readable at both widths, missing ids omit the entire block, recovery links remain visible, and no horizontal overflow was observed. Existing admin-brand contrast is poor: axe reports one serious `color-contrast` finding on `.brand` in both admin boundaries, at both widths, with identical node/contrast diagnostics before and after. This is not an all-clear accessibility claim. Public renders have no critical/serious axe findings. The feature adds no new contrast finding; it does not change admin chrome. No baseline was regenerated or accepted.

## Functional and build evidence

| Command / proof | Observed result |
| --- | --- |
| `npx vitest run test/kit-*.test.ts test/kit-*.test.mjs test/runbook-log-lines.test.ts test/request-log.test.ts test/hook-route-ownership.test.mjs` | 1927 passed, 70 skipped, 0 failed; 127 files passed / 3 skipped. Includes unchanged 22-case correlation acceptance. Skips are existing browser/DB opt-ins. |
| Expanded builder-owned boundary render test | Before prop fix: 2 failed / 4 passed, specifically missing hotzones and member-board references. After: 6/6 within the regression run. |
| `npm run check:kit-payloads:selftest`; `npm run check:kit-payloads` | Pass. All 29 server files classified; 25/25 dynamic proofs pass. Root layout is a public check, not an exemption; hostile member/session locals are excluded by an exact serialized-shape assertion. |
| `npm run lint`; `npm run typecheck`; `npm run e2e:typecheck` | Pass. |
| `npm run check --prefix web` | 1247 files, 0 errors, 0 warnings. |
| `npm run build --prefix web`; `node ci/check-kit-perf.mjs`, twice after the final prop fixes | Pass; 54/54 client file paths and SHA-256 hashes match across the two final builds. |
| `KIT_ERROR_SHELL_BROWSER_TESTS=true npx vitest run test/kit-error-shell-render.test.ts` | 41/41 executed, passed. |
| Node a11y/visual helper suites; smoke; E2E safety | 120/120, 407/407 and 320/320 passed respectively. |
| Cutover, shadow, bundle budget, performance gate selftests, Kit budget selftests, floor guard, strict test inventory | Pass. |

### Budget

Every numeric ceiling is identical to independently reviewed main, including the prerequisite in [#1666](https://github.com/TogetherWeOwn/two-web-next/pull/1666). Both histories are retained. No threshold is raised in this integration.

| Metric | Final measured | Unchanged main ceiling |
| --- | ---: | ---: |
| Worker raw / gzip | 2551 / 1219 B | 3584 / 1536 B |
| Server JS files | 116 | 126 |
| Server JS raw / gzip | 1163436 / 330149 B | 1203200 / 333312 B |
| Client JS files | 54 | 55 |
| Client JS raw / gzip | 254184 / 102729 B | 254464 / 102912 B |
| Client CSS files | 2 | 4 |
| Client CSS raw / gzip | 2861 / 1019 B | 3072 / 1024 B |

### Limits and failed attempts

- The first `npm run check` stopped at the newly integrated payload inventory: root `+layout.server.ts` was unclassified. Registering its executed no-member-data proof fixes that gate; the full chain was not rerun to completion.
- A separate full `npm test` ran for ten minutes, then hit the command timeout without a final summary. Its run-owned descendants were stopped. It observed a failure in unchanged `jobs-handoff` code (`invalid preflight causes zero mutations (missing API token)`); that is not claimed green or dismissed as a flake. The full suite remains unverified locally.
- The first ad-hoc screenshot/axe run stopped on the baseline admin-brand contrast finding. The subsequent diagnostic captures retain those failures and prove they are identical before and after; they do not turn that finding into a pass.
- `context-pack --base origin/main` failed because its MCP server exited. Caller checks must be done with direct source searches; this is not a successful context-pack run.
- Full DB integration, Hono `npm run a11y`, `npm run lighthouse`, `npm run lighthouse:quality`, and pinned-CI visual comparisons were not rerun. Hono gates do not exercise these Kit boundaries.
- No live environment was probed. Exact-head hosted CI and independent review remain required before merge. This evidence is not a staging PASS.

Skills used: paperclip, paperclip-superpowers-adapter, systematic-debugging, verification-before-completion, product-ui-design-loop.
