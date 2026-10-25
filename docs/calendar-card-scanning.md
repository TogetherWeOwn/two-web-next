# Scannable calendar cards

The shared Hono/Kit list card keeps title, game, schedule, place and participation
outside the description disclosure. Grid continuation links still target the
same unique list-card anchor.

## Design contract

- **Audience and job:** guests and members scan multiple events, understand an
  overnight endpoint in its host timezone, then open an event or participation link.
- **References:** preserve the existing schedule grid, typography and tokens in
  `public/schedule-theme.css`; reuse the native disclosure interaction already used
  by the subscription help. No new visual direction or framework.
- **Time:** both known instants use `time[datetime]`. Same host-day ends stay
  clock-only. A differing day adds weekday, day and month; a differing year also
  adds the end year. Invalid zones retain the existing UTC formatter fallback.
  An unknown Discord end stays absent.
- **Prose:** one shared threshold of **240 Unicode code points**, not UTF-16 units,
  for persisted and Discord rows. Short and exactly-at-limit descriptions remain
  unchanged. Longer descriptions show a bounded escaped prefix plus an ellipsis
  in native `details`/`summary`. Opening **Full description** replaces the preview
  with the complete text, rather than announcing both. The full text is available
  without JavaScript. The native marker, focus treatment and 44px target remain.
- **Responsive behavior:** preserve the three-column desktop and two-column mobile
  card. Long content wraps; disclosure does not contain the participation controls.
- **Non-goals:** detail/grid redesign, new reads, client scripts, storage limits,
  disclosure persistence and budget changes.

## Opened fixture screenshots

Full-page captures use 1280×800 and 390×844 viewports. All six linked images were
opened for visual review. The independently captured Hono and shared Kit HTML
native images are byte-identical at each width/state, so this table stores one
copy of each. The fixture contains a long overnight games event and a short
following event, with an Auckland device timezone and Los Angeles host timezone.

| State | Desktop | Mobile |
| --- | --- | --- |
| Before: unqualified end and full prose | [1280](visual-evidence/calendar-card-scan/before-1280.png) | [390](visual-evidence/calendar-card-scan/before-390.png) |
| After: bounded preview and dated end | [1280](visual-evidence/calendar-card-scan/after-1280.png) | [390](visual-evidence/calendar-card-scan/after-390.png) |
| Keyboard-expanded, preview replaced | [1280](visual-evidence/calendar-card-scan/expanded-1280.png) | [390](visual-evidence/calendar-card-scan/expanded-390.png) |

The browser acceptance also captures and checks enhanced continuation swaps and
re-collapse at both widths for both renderers. Those 20 after-state images and
eight before-state images were opened. Enter opens, Space closes, the full prose
appears once in the accessibility tree, and the next card returns to its collapsed
position. The no-JavaScript cases use the same native keyboard behavior.

## Verification and boundaries

```sh
npx vitest run test/calendar-card-scan-acceptance.test.ts \
  test/calendar-multiday-render-acceptance.test.ts \
  test/kit-events-calendar-parity.test.ts test/islands-calendar-fragment-zones.test.ts
# 128 passed, including 60 independent card-scanning cases.

NODE_OPTIONS=--import=tsx npx playwright test --config=e2e \
  calendar-card-scan-acceptance.spec.ts --workers=1 --retries=0
# 10 passed, zero skips. Local Chromium requires its normal runtime libraries.
```

The unchanged acceptance first failed with 40 renderer failures/20 controls and
10 missing-disclosure browser failures. The three independently authored files
were consumed without editing them. Additional passing checks: lint, TypeScript,
E2E TypeScript, asset synchronization, floor guard, strict test inventory, asset
budgets, a dry-run Worker build and its budget, and the Kit production build and
client/server budgets. The schedule stylesheet fits its unchanged 6144-byte raw
and 1792-byte gzip ceilings; no browser script changed.

`npm run a11y` passed on real local Hono fixture pages. These Hono gates do **not**
certify the whole SvelteKit routing stack; the Kit evidence above exercises the
shared calendar HTML entry point and real assets, not a deployed Kit Worker.

At this evidence checkpoint, **the full check is not green**. The full-suite run
observed an unrelated jobs-handoff preflight failure and the newly exposed
Lighthouse endpoint assumptions. The admission function now validates two
calendar endpoints, their exact two-hour fixture duration and each normalized
request-time window. Its targeted regression suite passes; the test-owned
Miniflare timestamp helper still requires an independent correction to recognize
the calendar end. No test was weakened or skipped.

Mobile and desktop Lighthouse commands were attempted, but the subsequent local
collection was blocked by a port occupied by another workspace. No LHR score or
threshold verdict is claimed. Pinned-runner visual comparison remains a CI gate;
no visual baseline was regenerated or accepted locally. No staging/production
probe, database migration or deployment is claimed. See the PR for subsequent
exact-head gate results and any intentional baseline evidence.
