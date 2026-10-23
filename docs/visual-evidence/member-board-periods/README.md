# Member-board period shortcuts

## Design contract

Members comparing attendance need familiar periods without learning season syntax.
The primary action is a native **This month**, **This quarter** or **All time** link,
retaining the selected game and Overall/Around-you scope.

References are the existing member-board form, the native period picker in
[`src/hotzones/pages.tsx`](../../../src/hotzones/pages.tsx), and the shared
schedule-view links in [`public/schedule-theme.css`](../../../public/schedule-theme.css).
Reuse their fonts, brand/ink/paper/line tokens and 44px link targets. Add a compact
period navigation above the unchanged historical GET form. A narrowly scoped rule
lets the row wrap at small widths. Only an exact selected period has a current
link; historical selections mark none. No new JavaScript, load-data fields,
ranking queries, privacy rules, caption changes or budget allowances.

Required states: historical, current month, current quarter, all time, empty and
unavailable. Keep historical input and invalid-season 400s. Native keyboard and
no-JavaScript navigation must work.

## Before and after

All images were captured and opened. Viewports are 1280×800 and 390×844;
captures are full-page. Synthetic fixture names and counts only, no member data.
The before page has season `2024-Q3`; after shows the selected month at the fixed
UTC instant `2032-04-01T00:00:00Z`. Both retain Around you and game `d&d`.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono / desktop | [Before](hono-1280-before.png) | [After](hono-1280-after.png) |
| Hono / mobile | [Before](hono-390-before.png) | [After](hono-390-after.png) |
| Kit / desktop | [Before](kit-1280-before.png) | [After](kit-1280-after.png) |
| Kit / mobile | [Before](kit-390-before.png) | [After](kit-390-after.png) |

The fixture compiles the real Kit load and page and calls the real Hono route.
Only bindings, SQL transport and session state are synthetic; the member-read
boundary and post-release view recorder remain real. Local styles and fonts are
used. Kit is server-rendered only, not a booted or hydrated deployment. These
screenshots are not staging or production evidence.

## Executed verification

```sh
TZ=America/Los_Angeles npx vitest run \
  test/member-board-period-shortcuts-acceptance.test.ts \
  test/member-leaderboard-route.test.ts \
  test/member-board-bad-filter-acceptance.test.ts \
  test/member-board-savable-games-acceptance.test.ts \
  test/kit-members.test.ts \
  test/kit-board-filter-400-recovery-acceptance.test.ts \
  test/member-board-viewer-acceptance.test.ts \
  test/member-leaderboard-relative-query-contract.test.ts

NODE_OPTIONS=--import=tsx TZ=America/Los_Angeles \
  npx playwright test --config=e2e member-board-period-shortcuts.spec.ts --workers=1
```

- Route/SSR RED: 52 missing-shortcut failures, 166 passes. GREEN: 218/218 pass.
- Browser RED: four missing-link failures, four passes. GREEN: 8/8 pass. Real
  Tab/Enter navigation without JavaScript at both widths, historical form submit
  and invalid bookmark/form 400 controls.
- Captured and opened all historical/month/quarter/all-time states for both
  renderers at both widths. A separate bounded loopback fixture run captured
  empty/unavailable states at both widths: eight 200 responses, no horizontal
  overflow and zero serious/critical axe violations. The fixture server closed.
- `npm run a11y`: 146 Hono fixture cases passed, no failures, sentinel rejected,
  cleanup confirmed. This gate does **not** exercise the Kit route; the real Kit
  SSR fixture screenshots and separate axe checks supply that evidence.
- `npm run build --prefix web` and `npm run kit-perf`: passed. Server JS gzip
  328224/329472 bytes; client JS gzip 99008/101632; client CSS gzip 983/1024.
- Kit typecheck: 1218 files, zero errors/warnings. External dependency linkage
  required normalizing only generated `$app/tsconfig.json` root directories;
  tracked configuration was unchanged.
- `npm run floor-guard`, strict test inventory (1130/1130), and `git diff --check`:
  passed. Independent acceptance files remain byte-identical to their handoff.
- `npm run lighthouse`: could not collect because the fixed local port was
  occupied. `npm run lighthouse:quality`: collected zero reports after Chrome
  failed to load a system library and its retry found the port occupied. These
  are **not passing Lighthouse verdicts**. No thresholds or audits were changed.
- CI visual-spec invocation refused this non-GitHub runner by design. No guard
  bypass, baseline update or local visual-suite pass is claimed. The pinned CI
  `browser-smoke` job remains required.

Full repository-check and exact-head CI results are recorded in the PR rather
than inferred from these targeted checks. No deployment is claimed here.
