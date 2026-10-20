# Continue a calendar search in the archive

## UI contract

Audience: members finding a game night beyond the calendar’s first 20 past matches.
The screen’s job is to continue that search, not expand the calendar preview.
The primary action is **Older**; **Newer** reverses it, and **Clear search** returns
to the ordinary archive. Show the actual query beside the matching rows.

References are the existing [calendar controls](../src/events/pages-calendar-controls.tsx)
and [archive screen](../src/events/pages-past.tsx). Assumption: preserve their
schedule rows, typography, spacing, colors, feed links and responsive layout;
this is not a new visual direction. At 1280×800 and 390×844 the query must wrap,
links must remain usable, and rows must not overflow.

Required states: populated matching pages, no matches with clear-search recovery,
out-of-range with a matching-page recovery, ordinary empty archive, bounded search
rejection and failed enhanced navigation retaining the last good page. Native
links work without JavaScript; enhancement retains the existing deadline, focus
ownership, history and metadata protections. Non-goals: a search engine, new query
syntax, feed search, schema changes or a larger preview.

## Behavior and boundaries

`/events?q=…&past=1` retains its 20-row past preview. Its archive link preserves
`q`; `/events/past?q=…` applies the existing title/description literal search
before both SQL count and paging. Pages remain 20 rows, ordered by start time then
ID descending. Archive visibility remains explicit past rows or ended published
rows; drafts and cancelled rows remain excluded.

Search uses the calendar’s raw 255-code-point admission limit, then strips NUL
and trims outer whitespace. Case-insensitive matching preserves internal
whitespace; `%`, `_` and backslash are literals, not a new pattern grammar.
Oversized raw input is rejected before database reads and cache lookup, even if
normalization would turn it blank. Blank normalized input is the ordinary archive.

Pager and canonical URLs contain only archive state (`page` and `q`). Native and
enhanced paging, copied URLs, reload and Back/Forward retain the query. Clearing
search intentionally removes it and returns to page one. No matches is different
from requesting a page beyond the matching archive; both have recovery links.

Filtered responses use private, no-store and cannot read or populate anonymous
archive entries. Ordinary archive caching retains its existing page-only keys,
TTL, populated-page eligibility and retire-generation fence in both Hono and Kit.
No query-specific shared cache keys are added.

## Opened before/after screenshots

These full-page captures use real route/loader SSR, shipped local assets and
synthetic fixture rows. Viewports are 1280×800 and 390×844. Before is the unchanged
`dcaaeaf37` source snapshot; after includes this change. Existing shell defaults
are retained (Hono dark; Kit archive light). These are not staging captures.

| Twin / viewport | Before (unfiltered rows) | After (matching rows and clear) |
| --- | --- | --- |
| Hono desktop | [Before](images/past-archive-search/hono-1280-before.png) | [After](images/past-archive-search/hono-1280-after.png) |
| Hono mobile | [Before](images/past-archive-search/hono-390-before.png) | [After](images/past-archive-search/hono-390-after.png) |
| Kit desktop | [Before](images/past-archive-search/kit-1280-before.png) | [After](images/past-archive-search/kit-1280-after.png) |
| Kit mobile | [Before](images/past-archive-search/kit-390-before.png) | [After](images/past-archive-search/kit-390-after.png) |

## Verification and release evidence

The independent acceptance fixtures exercise both real route/loader/render paths,
real disposable PostgreSQL filtering, and local Chromium native/enhanced history
navigation. The builder leaves their owned files unchanged. Desktop/mobile captures
and command results are attached to the implementation pull request. Hono quality
gates do not exercise the Kit route; its fixture/browser evidence is reported
separately. No baseline or quality limit is loosened.

Source verification is not deployment evidence. Exact-head CI and independent
review precede merge; staging verification and production promotion follow the
existing [release contract](releases.md). Observed release state is recorded on
the delivery task rather than claimed from a passing local fixture.
