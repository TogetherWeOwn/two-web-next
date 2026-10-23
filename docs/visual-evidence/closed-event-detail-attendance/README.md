# Closed event detail shows final attendance

## Design contract

Guests and members opening a past or cancelled event page must see final
attendance, never a seat invitation. Past detail keeps the going count and
drops the spots-left/full line; cancelled detail (the 410 page) shows the
retained-responses history line with no capacity; published detail keeps
count plus spots-left byte-identical.

The precedent is the schedule card
(`src/events/pages-calendar-card.tsx:96-118`): past and cancelled cards stay
unmarked, cancelled cards read `existingResponsesText`. The lineup badge keeps
its island mount, testids, roles and copy helpers; the gone page gains one
static line after the title (no island mount: a closed event takes no RSVPs,
so there is nothing to refresh). No new query, read, client script, CSS or
copy vocabulary. Required states: past full/nearly-full/no-capacity/
zero-going, cancelled including singular, published unchanged, island
refresh/retry/stale on closed events materializing no spots node, native
keyboard/no-JS journeys unchanged.

## Before and after

All images were captured and opened. Desktop viewports are 1280×800
(viewport captures); mobile viewports are 390×844 (full-page captures, so
the below-fold lineup is visible). Synthetic fixture only: "Chess night",
past full (10 of 10), cancelled with 9 responses, published nearly-full
(9 of 10, 1 spot left).

| Renderer / state | Before (1280) | After (1280) | Before (390) | After (390) |
| --- | --- | --- | --- | --- |
| Hono / past | [Before](hono-past-1280-before.png) | [After](hono-past-1280-after.png) | [Before](hono-past-390-before.png) | [After](hono-past-390-after.png) |
| Hono / cancelled | [Before](hono-cancelled-1280-before.png) | [After](hono-cancelled-1280-after.png) | [Before](hono-cancelled-390-before.png) | [After](hono-cancelled-390-after.png) |
| Hono / published | [Before](hono-published-1280-before.png) | [After](hono-published-1280-after.png) | [Before](hono-published-390-before.png) | [After](hono-published-390-after.png) |
| Kit / past | [Before](kit-past-1280-before.png) | [After](kit-past-1280-after.png) | [Before](kit-past-390-before.png) | [After](kit-past-390-after.png) |
| Kit / cancelled | [Before](kit-cancelled-1280-before.png) | [After](kit-cancelled-1280-after.png) | [Before](kit-cancelled-390-before.png) | [After](kit-cancelled-390-after.png) |
| Kit / published | [Before](kit-published-1280-before.png) | [After](kit-published-1280-after.png) | [Before](kit-published-390-after.png) | [After](kit-published-390-after.png) |

Byte proof: both published pairs are `cmp`-identical HTML; each closed pair
differs in exactly one contiguous region (the removed spots node, or the
added `event-existing-responses` line). Both published PNG pairs are
pixel-identical (`cmp`); the four closed pairs differ.

The fixture calls the real Hono route (`test/app.ts` under tsx) and the
real Kit resolver plus SSR-compiled `EventDetail`/`EventGone` components.
Only bindings, SQL transport and session state are synthetic. Hono shots
serve the real `public/` assets; Kit shots link the real `/event-theme.css`
and the compiled `web/src/app.css` token sheet (built with the repo's
Tailwind pipeline), inside a screenshot-only shell shared byte-for-byte by
before and after. Kit is server-rendered only, not a booted or hydrated
deployment. These screenshots are not staging or production evidence.

## Executed verification

```sh
npx vitest run test/closed-event-detail-attendance-acceptance.test.ts
# 36 passed (was 20 failed / 16 passed at the base pin)
npx vitest run test/kit-event-detail.test.ts test/kit-event-states.test.ts \
  test/event-page.test.ts test/event-theme.test.ts test/event-navigation.test.ts \
  test/islands-going-count.test.ts test/event-page-spots.test.ts \
  test/event-page-share.test.ts test/event-gone-alternatives-acceptance.test.ts \
  test/calendar-cancellation-copy.test.ts test/calendar-card-fullness-pins.test.ts \
  test/islands-paused-cancelled-a11y.test.ts
# 12 files, 189 passed, 21 skipped (DB-gated)
npm run lint        # clean
npm run typecheck   # clean
npm run a11y        # 146 PASS, exit 0
```

## CI visual-baseline review

The [browser-smoke run](https://github.com/TogetherWeOwn/two-web-next/actions/runs/39988487720)
reported exactly two visual failures: `event-cancelled-desktop.png` and
`event-cancelled-mobile.png`; the other 15 visual cases passed. Its ordinary
journeys passed 236/236 and Kit parity passed 75/75. The required `e2e-ok`
aggregator remained red because the visual comparison failed.

Downloaded `e2e-failure-39988487720-1` and opened both expected, actual and
diff images. Both actuals add the intended `0 existing responses` line
below the cancelled title. The alternatives, CTA and footer move down with
that line; no other intended visual change. Desktop grows from 1280×1322
to 1280×1374; mobile grows from 390×1256 to 390×1308. Accepted only these
two actuals with `node ci/visual-accept.mjs <artifact-dir>` (2 baselines;
2 stale artifact copies superseded). Thresholds, masks, specs and the
paired acceptance file were not edited by the implementation author.

Accepted PNG SHA-256:

- Desktop: `e3a4843d8243c454f3ee12c6bad0d633dd0a96c5ffa58613dd6c9c46e67b0e32`
- Mobile: `38d4bde5bbaba578e3b69355bed76c7917ee3aa6422d99ac9130b5050a8b8451`

The unchanged acceptance suite was rerun: 36/36 passed (the existing
`$app/tsconfig` base-config warning remains). `node --test
ci/visual-accept.test.mjs` passed 40/40, and `npm run lint` passed. These
local checks do not replace a fresh pinned-runner visual comparison after
push. At head `30b81c7b`, CI `ci-ok`, `lighthouse`, `a11y`, `gitleaks` and
`pr-lint` passed; CodeQL separately identified the test helper's HTML
filtering regex and requires its author-owned correction before merge.

## Author-owned test correction

Consumed commit [`98b7e016830fb9bb0dc705d81bf25b88ef28c2e0`](https://github.com/TogetherWeOwn/two-web-next/commit/98b7e016830fb9bb0dc705d81bf25b88ef28c2e0)
unchanged. Its acceptance-file bytes match the correction commit exactly.
The helper now extracts visible text with the existing Miniflare
HTMLRewriter rather than HTML-filtering regexes, and adds a mixed-case /
permissive-closing regression. No product code, dependency, assertions or
thresholds were removed or weakened in this repair.

Fresh verification after consumption: the acceptance suite passes 37/37;
`npm run lint`, `npm run typecheck`, `node --test
ci/visual-accept.test.mjs` (40/40) and `git diff --check` pass. The initial
acceptance attempt could not start because the prior run's external
dependency directory had been removed; reinstalling the locked dependencies
outside the checkout restored verification. The existing `$app/tsconfig`
warning remains. Fresh CodeQL and pinned-runner visual CI are still
required; these local results do not substitute for either gate.
