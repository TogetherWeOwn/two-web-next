# Admin focus stylesheet scope — 2026-10-25

## Delta design contract

Same moderator audience, investigation job, native navigation actions and required
states as the [original contract](../README.md#design-contract). Preserve layout,
typography, tokens, colors and responsive behavior. The existing admin shells and
admin-only review stylesheet are the implementation references. Move the exact
join-link focus selector/declaration to that already-linked stylesheet; do not add
a request or change the DOM. No redesign or broader shell accessibility claim.

The shared stylesheet is also inlined in public pages. The previous integration
failed the immutable homepage raw-size test: **24,866 > 24,800 bytes** locally
(the hosted run measured 24,867). The unused admin rule contributed 73 bytes.
Moving it out restores `assets/styles.css`, `public/styles.css` and
`src/leaf-critical-css.ts` to byte-identical copies of incoming main. Both admin
shells already link `/admin-rsvp-review.css` after `/styles.css`; the same rule
still applies there. No size ceiling or acceptance test changed for this fix.

## Opened comparisons

Each PNG shows **before on the left, after on the right**, with a native
keyboard-focused link and JavaScript disabled. Each half is 1280×800 or 390×844.
All eight PNGs were opened. The raw rendered channels are identical in every
pair; [manifest.json](manifest.json) records the comparison results.

| Twin | Width | Filtered empty | Incomplete list |
| --- | --- | --- | --- |
| Hono | 1280 | [Pair](Hono-1280-filtered-empty-before-left-after-right.png) | [Pair](Hono-1280-incomplete-list-before-left-after-right.png) |
| Hono | 390 | [Pair](Hono-390-filtered-empty-before-left-after-right.png) | [Pair](Hono-390-incomplete-list-before-left-after-right.png) |
| Kit | 1280 | [Pair](Kit-1280-filtered-empty-before-left-after-right.png) | [Pair](Kit-1280-incomplete-list-before-left-after-right.png) |
| Kit | 390 | [Pair](Kit-390-filtered-empty-before-left-after-right.png) | [Pair](Kit-390-incomplete-list-before-left-after-right.png) |

These are real Hono and compiled Kit SSR fixture renders with actual public CSS;
Kit additionally uses compiled root `web/src/app.css`. Every request is intercepted
locally; fixtures contain no member data. The existing dark Kit brand contrast is
unchanged, not newly certified by these images.

## Fresh verification

- `vitest run test/homepage-mobile-lcp-acceptance.test.ts test/join-investigation-acceptance.test.ts`: before relocation **1 failed / 50 passed**, the failure is the homepage raw ceiling.
- After relocation, those two suites plus `test/leaf-css-drift.test.ts`, `test/join-investigation-context-regression.test.ts` and `test/join-investigation-parity-oracle.test.ts`: **122/122 passed**.
- `NODE_OPTIONS=--import=tsx playwright test --config test/helpers/join-investigation-focus.config.ts`: **8/8 passed**. The existing native journey config: **12/12 passed**. Both use installed Chromium with its local library path, no retries or skipped assertions.
- `npm run lint`, `npm run typecheck`, `npm run e2e:typecheck`, `npm run build:assets:check`, strict inventory **1242/1242**, `npm run floor-guard`, `npm run budget`, Kit production build and `npm run kit-perf`: passed. Admin CSS is **532/1024 raw, 334/512 gzip bytes**. Kit client JS is **254255/254464 raw, 102732/102912 gzip**; server gzip **333141/333312**. All caps equal the separately reviewed allocation already merged in [#1783](https://github.com/TogetherWeOwn/two-web-next/pull/1783).
- Unmodified `npm --prefix web run check` hit the known external dependency-link issue (130 missing generated route-type errors). Correcting only the run-owned generated `$app/tsconfig.json` roots, then running `svelte-check --workspace web --tsconfig <web-tsconfig> --fail-on-warnings`, produced **1231 files, zero errors/warnings**. No tracked compiler change.

Full-check and Lighthouse outcomes are recorded in the PR verification update;
these focused receipts do not establish that either passed. Hono accessibility
and Lighthouse do not exercise Kit-only routes. Pinned-runner visual comparison,
exact-head hosted CI and independent review remain required. No visual baseline,
audit, score floor or byte ceiling was relaxed. No staging/production test,
probe, migration, deployment or release was performed.
