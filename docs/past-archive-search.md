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

## Game facet

The archive carries the schedule’s game facet into history. `/events/past?game=…`
narrows to one stored game, alone or intersected with the literal text search, so
members find prior nights for a game even when its name appears in neither titles
nor descriptions. The schedule’s archive-continuation link carries the selected
game (and query) with it. Game matching is trim + case-insensitive exact through
the same shared predicate the schedule facet uses, applied identically to the
archive count and rows before the 20-row paging; ordering stays start time then
ID descending.

Suggestions come from one capped, ordered distinct read over archive-visible
games (explicit `past` rows, even with a recorded future end, plus ended
`published` rows) — never the schedule’s published-only list. At most 100
suggestions render; when more exist the page says so, and a selected game beyond
the cap stays selected as a zero-or-more-match filter instead of silently
becoming All games. A syntactically valid unknown game is likewise retained as a
zero-match filter. Blank games are the ordinary archive with ordinary cache keys.

Raw games over 255 code points, NUL-bearing games, conflicting duplicate `game`
values and conflicting duplicate `q` values are refused with a branded 400 before
any throttle spend, database read or cache lookup; the overlong text query keeps
its existing 422. The native GET form (labelled select, preserved query, Search
submit) works without JavaScript and resets a changed facet to page one; pager,
canonical, detail context (`archiveGame` beside `archivePage`/`archiveQuery`) and
the enhanced island retain the game through paging, reload and Back/Forward.
Zero-match and past-end pages stay distinct, with independent clear-game /
clear-text recovery (or an explicitly labelled clear-all) that truthfully names
the state it removes.

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

## Game facet captures

Same fixture method as above: real Hono route HTML and real Kit loader/Svelte
SSR over disposable PostgreSQL rows (interleaved Go/Chess nights plus an
explicit-past-only game), served with shipped local assets and captured in local
Chromium at 1280×800 and 390×844. Before is the unchanged `6d75b3afb` source
snapshot; after includes the facet. Kit renders without the root layout’s
bundled app.css in this harness (light token fallback, as in the earlier Kit
captures); structure, copy and state are the real loader/SSR bytes. Every linked
image was opened.

| Twin / viewport | Before (no facet) | After (game-filtered rows and clear) |
| --- | --- | --- |
| Hono desktop | [Before](images/past-archive-game/hono-1280-before.png) | [After](images/past-archive-game/hono-1280-after.png) |
| Hono mobile | [Before](images/past-archive-game/hono-390-before.png) | [After](images/past-archive-game/hono-390-after.png) |
| Kit desktop | [Before](images/past-archive-game/kit-1280-before.png) | [After](images/past-archive-game/kit-1280-after.png) |
| Kit mobile | [Before](images/past-archive-game/kit-390-before.png) | [After](images/past-archive-game/kit-390-after.png) |

Required after-states (Hono; Kit mirrors hold by the twin suites):

| State | Desktop | Mobile |
| --- | --- | --- |
| Unfiltered with facet | [1280](images/past-archive-game/hono-1280-unfiltered.png) | [390](images/past-archive-game/hono-390-unfiltered.png) |
| Game + text page two | [1280](images/past-archive-game/hono-1280-gametext.png) | [390](images/past-archive-game/hono-390-gametext.png) |
| Zero-match miss | [1280](images/past-archive-game/hono-1280-miss.png) | [390](images/past-archive-game/hono-390-miss.png) |
| Past-end recovery | [1280](images/past-archive-game/hono-1280-oor.png) | [390](images/past-archive-game/hono-390-oor.png) |
| Capped suggestions, retained selection | [1280](images/past-archive-game/hono-1280-capped.png) | [390](images/past-archive-game/hono-390-capped.png) |
| Invalid filter 400 | [1280](images/past-archive-game/hono-1280-invalid.png) | [390](images/past-archive-game/hono-390-invalid.png) |

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
