# Kit error correlation: merge evidence

## Design contract

- Audience: members on public error pages and moderators recovering from a throttled save.
- Screen job: explain the refusal without echoing the failure, retain recovery links, and expose the served support reference.
- Primary action: reopen the refused admin form on an admin 429; retain the existing Discord-invite and retry/home actions elsewhere.
- Real content: shared `kitErrorCopy`, the existing admin way-back note and form label, and the synthetic reference `0123456789abcdef-LHR`.
- References: the existing `ErrorShell.svelte`, `src/admin-wayback.ts`, and Hono support-reference copy. Preserve their design; no new visual direction.
- Layout, typography and tokens: existing Shell, recovery hero/actions, Display/body fonts and Open Lobby CSS. No stylesheet edits in this resolution.
- Responsive behavior: preserve centered desktop recovery and stacked mobile links, with the reference visible at both widths.
- States: admin 429 with both reference and form link; public 503 with reference and no admin link. Blank-safe absence and other statuses remain covered by the acceptance suite.
- Non-goals: redesign, new telemetry, hydration, session/database reads, or visual baseline regeneration.

## Screenshot evidence

The before source is `cbe86d9d`; after is the conflict resolution with main `f596ee15b`. Both use the merged tree's served styles and font files to isolate the boundary/prop change. These are the real SSR-compiled root boundary and ErrorShell against synthetic `$app/state`, not deployed pages. Chromium intercepted every request with local fixture bytes; no live service or database was contacted. Viewports are 1280×800 and 390×844, with full-page capture.

| State | Desktop before / after | Mobile before / after |
| --- | --- | --- |
| Admin 429 | [Before](before-admin429-desktop.png) / [After](after-admin429-desktop.png) | [Before](before-admin429-mobile.png) / [After](after-admin429-mobile.png) |
| Public 503 | [Before](before-public503-desktop.png) / [After](after-public503-desktop.png) | [Before](before-public503-mobile.png) / [After](after-public503-mobile.png) |

All eight images were opened. Admin 429 keeps the support reference and gains main's unsaved-submission note and form link at both widths. The public 503 before/after PNGs are byte-identical at both widths. No clipped copy, horizontal overflow or missing recovery controls was observed. No visual baselines were accepted or changed.

## Verification

| Evidence | Observed result |
| --- | --- |
| Correlation, error outcome, guard, join-attempt boundary, admin way-back, public-read pins and runbook suites | 9 files, 155 passed; includes untouched 22-case correlation acceptance |
| Root layout, hotzones/members and public-503 binding suites | 3 files, 21 passed |
| Neighboring route/hook ownership, admin guide, member refusal, public 503, activity-log, endpoint, hotzones, session and request-log suites | 10 files, 247 passed |
| `KIT_ERROR_SHELL_BROWSER_TESTS=true npx vitest run test/kit-error-shell-render.test.ts` | 28 passed, including executed Chromium/axe checks |
| `npm run lint`, `npm run typecheck`, `npm run e2e:typecheck` | Passed |
| `npm run check --prefix web` | 1214 files, 0 errors, 0 warnings |
| `npm run build --prefix web`, `node ci/check-kit-perf.mjs` | Passed after attributed budget reconciliation: server 121/121; client 51/51, raw 242674/243200, gzip 97771/98048 |
| Pristine main with the same locked dependencies | Build and budget pass: server 120 files, raw 1078903/gzip 317850; client 51 files, raw 242068/gzip 97511 |
| `npm run docs:links`, `npm run config:check`, `npm run budget`, `npm run floor-guard -- --base origin/main`, `npm run test:inventory -- --strict` | Passed |
| Runbook correction red-before | New Kit-search caveat pin failed once (17 passed, 1 failed); corrected docs make all 18 pass |

Initial tool failures were environmental or invocation errors: absent root dependencies caused `biome: not found` and a missing `drizzle-orm` build import; locked root/web installs restored them. The binding files import Vitest, so invoking them with `node --test` failed; rerunning with Vitest passed. None was treated as a product regression or bypassed.

The full workspace suite, Hono Lighthouse/a11y commands, staging and production were not run in this conflict heartbeat. The Hono gates do not exercise these Kit routes. Exact-head hosted CI and independent review remain required before merge.

Skills used: paperclip-superpowers-adapter, systematic-debugging, verification-before-completion, product-ui-design-loop.
