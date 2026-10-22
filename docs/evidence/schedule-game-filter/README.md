# Schedule game filter: browser evidence

## Design contract

- **Audience/job:** members and guests finding upcoming community game nights.
- **Primary action:** choose a published game, optionally enter a title/description query, and submit the existing Search GET form.
- **References/assumptions:** retain the existing schedule search, native month-jump control and leaderboard activity facet; no new visual direction or routes.
- **Layout/type/tokens:** preserve the schedule shell, typography, cards and dark tokens. Keep the visible game label with a native, 52px select; wrap the group beside Search below the input on narrow screens.
- **States:** All games, recognized game, combined search hit/miss, unknown/blank fallback, list and calendar. Announce recognized filters through the existing search-status live region.
- **Non-goals:** taxonomy management, game editing, archive-only filtering, feed filtering and Kit enablement changes.

## Captures

These are the real Hono HTTP route and Kit `loadEventsPage` → `renderEventsHtml` response, served locally with production static assets and hermetic pg-proxy fixtures. No production or staging database was used. Before captures use `3eb3a6362`; after captures use this change. Every image below was opened for visual inspection. These are review evidence, not regenerated visual-test baselines.

| State | Desktop, 1280 × 800 | Mobile, 390 × 844 |
| --- | --- | --- |
| Before: list | [PNG](before-list-1280.png) | [PNG](before-list-390.png) |
| Before: calendar | [PNG](before-calendar-1280.png) | [PNG](before-calendar-390.png) |
| After: All games | [PNG](head-list-1280.png) | [PNG](head-list-390.png) |
| After: Chess list | [PNG](head-filtered-1280.png) | [PNG](head-filtered-390.png) |
| After: Chess calendar | [PNG](head-calendar-1280.png) | [PNG](head-calendar-390.png) |
| After: Chess + Alpha hit | [PNG](head-combined-1280.png) | [PNG](head-combined-390.png) |
| After: Chess + missing query | [PNG](head-miss-1280.png) | [PNG](head-miss-390.png) |
| After: unknown game, unfiltered | [PNG](head-unknown-1280.png) | [PNG](head-unknown-390.png) |
| After: Kit Chess list | [PNG](head-kit-filtered-1280.png) | [PNG](head-kit-filtered-390.png) |

All 18 responses returned 200 without page-level horizontal overflow. The mobile month grid intentionally retains its existing horizontally scrollable region.

## Interaction proof

Chromium exercised the native select using keyboard ArrowDown/Enter, then submitted Search. Both JavaScript-enabled fragment navigation and JavaScript-disabled native GET submission selected Chess, updated the URL, announced Chess and excluded Go cards.

The same browser harness reproduced month-jump filter loss before its fix (`null !== 'Chess'`), then passed with JavaScript both enabled and disabled: jumping from July to August retained `game=Chess`. The harness uses the serving origin in `APP_URL`, so island navigation is exercised rather than rejected as cross-origin.

The immutable acceptance suite also checks Hono/Kit filtering, blank/unknown fallback, escaping, combined queries, paging and the single bounded distinct read. The separate archive and feeds intentionally remain unfiltered, as documented in the root README.

The Hono quality gates do not exercise a deployed Kit route. The Kit captures here exercise its shared loader/HTML renderer, not Svelte hydration or route enablement. Changed-revision staging verification follows deployment; these local captures are not staging evidence.
