# Adjacent game-night previews

## Design contract

- **Audience and job:** people comparing recurring game nights with identical titles need to see when and where the destination happens before following a link.
- **Primary action:** follow Previous or Next in either the series rail or the chronological global rail. Keep those rails independently labelled and selected.
- **Content:** direction and destination title, the destination's server-formatted start date/time, and its known location. Use a native `time` with the destination instant in `datetime`. Omit absent locations; do not guess a venue or convert to the viewer's device zone.
- **References:** retain the existing [event theme](event-theme.md), the related-event card metadata in `src/events/pages-detail.tsx`, and the existing pagination snippet in `web/src/lib/EventDetail.svelte`. No new visual direction.
- **Layout and typography:** title above secondary date and venue, using existing fonts, muted text, link appearance, separators and spacing. Two columns where space permits; stacked, wrapping links on narrow screens. Keep the entire preview inside its native link.
- **States:** both, previous-only, next-only and neither; standalone and independent/degraded rails; missing, long and hostile titles/venues; DST folds, year rollover and invalid-zone fallback; keyboard and no JavaScript.
- **Non-goals:** selection algorithms, new reads/storage/scripts, current-event scheduling, archive return context, attendee data, series editing or a framework change.

## Opened fixture screenshots

These are full-page captures of the real Hono and Svelte SSR renderers at the named viewport sizes, using synthetic events and the shipped event stylesheet. Kit also loads its actual compiled `web/src/app.css`. JavaScript is disabled in these captures; separate browser cases exercise both JavaScript settings. No staging or production request is involved.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono, 1280×800 | [Before](evidence/adjacent-previews/before-Hono-1280.png) | [After](evidence/adjacent-previews/after-Hono-1280.png) |
| Hono, 390×844 | [Before](evidence/adjacent-previews/before-Hono-390.png) | [After](evidence/adjacent-previews/after-Hono-390.png) |
| Kit, 1280×800 | [Before](evidence/adjacent-previews/before-Kit-1280.png) | [After](evidence/adjacent-previews/after-Kit-1280.png) |
| Kit, 390×844 | [Before](evidence/adjacent-previews/before-Kit-390.png) | [After](evidence/adjacent-previews/after-Kit-390.png) |

## Focused verification

The independent acceptance commit is `a4b128a01eef59212394a7f5900dd82da0a21cb9`. Its five files are consumed unchanged. The author credit remains on the test commit.

```sh
env -u DATABASE_URL -u BOT_DATABASE_URL npx vitest run \
  test/event-adjacent-preview-acceptance.test.ts \
  test/event-adjacent-preview-reads.test.ts \
  test/event-series-context-acceptance.test.ts \
  test/event-series-context-bounds-acceptance.test.ts \
  test/event-detail-format.test.ts

NODE_OPTIONS=--import=tsx npx playwright test \
  --config=e2e/adjacent-preview-fixtures.config.ts
```

Before implementation, the five-suite Vitest run observed 16 failures and 67 passes; browser acceptance observed 16 failures and 8 passes. Failures were the missing destination date, native time and venue.

After implementation, the nine-suite run (the five above plus `event-theme`, `event-navigation`, `kit-event-detail` and `event-detail-decorative-fail-open`) observed 171 passes and 21 skips with `DATABASE_URL` unset. The new actual-SQL acceptance controls use their own guarded disposable schemas and all executed. The 24 browser cases passed: both renderers, both widths, JavaScript on/off, accessible link names, long unbroken text without horizontal scroll, and native Tab/Enter navigation.

The event-theme compactness regression initially rejected 6277 characters against its existing `<6150` limit. Reusing the existing related-event metadata styles reduced the stylesheet to 6125 bytes; the unchanged regression then passed. No threshold was relaxed.

`npm run build --prefix web` and `npm run kit-perf` passed. Measured server JS gzip was 328079/329472 bytes, client JS gzip 98792/101632 and client CSS gzip 983/1024. No budget changed.

Hono's `npm run a11y`, `npm run lighthouse` and `npm run lighthouse:quality` do **not** exercise Kit routes. Kit's evidence is its real SSR fixture screenshots, browser acceptance and build/budget checks, not an inference from Hono's scores. Full-check and remote CI outcomes are recorded in the pull request. The pinned CI visual comparison refuses local execution; any intentional baseline updates must come from reviewed CI failure artifacts, not these documentation images.

## Undo

Revert the single behavior PR if a regression appears. There are no data changes or migrations. A merge alone is not evidence of deployment.
