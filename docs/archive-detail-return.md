# Return to the same archive results

## Design contract

Audience: people opening an older event from a particular archive result,
including in another tab. The detail screen's job is to retain a useful route
back without relying on history, storage or a referrer.

The primary action is the existing back link above the event heading:
**Back to search results** for filtered context, **Back to past events** for
an ordinary archive page, and the existing **All events** for direct visits or
rejected context. Keep the query out of the short label so long searches do not
crowd the mobile header.

References: the existing [archive](../src/events/pages-past.tsx),
[detail shell](../src/events/pages-shared.tsx) and
[Kit detail](../web/src/lib/EventDetail.svelte). Assumption: retain their
placement, typography, spacing, color tokens and responsive layout. No visual
redesign or CSS change is needed. Native links remain keyboard-accessible with
JavaScript disabled. Enhanced archive turns receive the same complete SSR links.

Required states: filtered page two, unfiltered pages one/two, direct and invalid
context fallback, refreshed/new-tab detail, attendee pages and both native and
live-read roster refresh. Non-goals: search policy, arbitrary return URLs,
OAuth return paths, RSVP write behavior, persistent state or route ownership.

## Transport and trust boundary

Archive cards carry scalar `archivePage` and optional `archiveQuery` fields.
The producer uses the archive's normalized page/query, including its existing
page parsing. The detail boundary accepts exactly one canonical positive safe
page with the existing archive offset bound, and at most one query of at most
255 raw Unicode code points. It reuses `matchQuery` for NUL removal, newline
normalization and outer trimming. Oversized input is refused before normalization.
Malformed percent/UTF-8 encoding and duplicate recognized fields are refused,
including duplicate encoded names. Rejected or absent context keeps All events.

Only `/events/past` is reconstructed, through the existing `pastEventsUrl`
builder and its `page`/`q` grammar. An external-looking string can be a literal
search term, never a navigation destination. There is no new redirect, session
state, authorization grant or database read.

Attendee pager and Refresh links retain admitted archive state independently
of `attendees`. The live-read island forwards only bounded, unambiguous scalar
archive fields to the same detail route; the server still decides admission.
It does not change the RSVP POST or its return policy. Invalid context cannot
become valid through URLSearchParams repairing malformed UTF-8 or dropping a
duplicate. Canonical, copy, Open Graph, JSON-LD, ICS and Google Calendar URLs
remain context-free. Auth, member audit, cache headers and gone/draft/status
behavior are unchanged.

## Opened fixture captures

The captures use real Hono route HTML and real Kit loader/Svelte SSR with
synthetic events, memory sessions, local assets and a fake external audit sink.
The browser reaches a run-owned loopback socket through an intercepted fixture
origin; all off-origin traffic is blocked. There are no staging/production
requests or real member records. Kit's compiled root CSS is injected by the
fixture harness because it renders the page without the root layout.

Before captures precede the behavior change. Viewports are 1280×800 and 390×844;
the archive/detail/fallback images are full-page. Every linked image was opened.
The synthetic Unicode query is `Raid 🌌 "night" & <crew>`; this container's
available fonts show the emoji as a missing glyph in both before/after images.
The query bytes and URL round-trip are separately asserted.

| Twin / width | Archive before | Archive after | Detail before | Detail after |
| --- | --- | --- | --- | --- |
| Hono 1280 | [Before](images/archive-detail-return/before/hono-1280-archive.png) | [After](images/archive-detail-return/after/hono-1280-archive.png) | [Before](images/archive-detail-return/before/hono-1280-detail.png) | [After](images/archive-detail-return/after/hono-1280-detail.png) |
| Hono 390 | [Before](images/archive-detail-return/before/hono-390-archive.png) | [After](images/archive-detail-return/after/hono-390-archive.png) | [Before](images/archive-detail-return/before/hono-390-detail.png) | [After](images/archive-detail-return/after/hono-390-detail.png) |
| Kit 1280 | [Before](images/archive-detail-return/before/kit-1280-archive.png) | [After](images/archive-detail-return/after/kit-1280-archive.png) | [Before](images/archive-detail-return/before/kit-1280-detail.png) | [After](images/archive-detail-return/after/kit-1280-detail.png) |
| Kit 390 | [Before](images/archive-detail-return/before/kit-390-archive.png) | [After](images/archive-detail-return/after/kit-390-archive.png) | [Before](images/archive-detail-return/before/kit-390-detail.png) | [After](images/archive-detail-return/after/kit-390-detail.png) |

| Required state | Hono desktop / mobile | Kit desktop / mobile |
| --- | --- | --- |
| Invalid context, All events fallback | [1280](images/archive-detail-return/after/hono-1280-fallback.png) / [390](images/archive-detail-return/after/hono-390-fallback.png) | [1280](images/archive-detail-return/after/kit-1280-fallback.png) / [390](images/archive-detail-return/after/kit-390-fallback.png) |
| Unfiltered archive, Back to past events | [1280](images/archive-detail-return/after/hono-1280-unfiltered.png) / [390](images/archive-detail-return/after/hono-390-unfiltered.png) | [1280](images/archive-detail-return/after/kit-1280-unfiltered.png) / [390](images/archive-detail-return/after/kit-390-unfiltered.png) |
| Member attendee page two, native pager/refresh | [390, scrolled viewport](images/archive-detail-return/after/hono-390-roster.png) | [390, scrolled viewport](images/archive-detail-return/after/kit-390-roster.png) |

Browser assertions exercised keyboard Enter on the archive card and back link
with JavaScript off, same-tab/new-tab/reload, exact returned query/page,
enhanced archive page turns (an actual fragment fetch on each twin), native
member roster pages one/two/three and Refresh, and a live roster-read broadcast
whose response keeps context in the replaced Next link. The broadcast is a
read-only fixture event, not a production RSVP write.

## Production-build checks

The Kit server build also needs to retain the parser's throwing validation.
Rolldown removes an unused `decodeURIComponent(search)` call, even with the
conservative SSR minification settings. Consuming the result in an empty-search
refusal keeps that check observable without decoding the input passed to
`URLSearchParams`. The compiler regression in
[`archive-context-build.test.ts`](../test/archive-context-build.test.ts) first
failed on malformed input, then passed with the fix. It also exercises duplicate
and noncanonical pages, Unicode normalization and the 255-code-point boundary.

After main was incorporated into PR #1699, its server gzip measured 329740B
against the unchanged 329472B ceiling. Co-compress the four thin Kit archive/detail
route bindings with their existing event views and resolvers, in the SSR-only
`events` group. Their module-level work is declarations; environment, database,
cookie and page-context reads remain inside invoked loaders/renderers. Keep
client chunking, route ownership, legal comments and conservative minification
unchanged; do not increase a budget.

Locked Node 24.22.1 / npm 11.19.1 builds measured the complete emitted server JS:

| Build | Files | Raw B | Gzip B | Ceiling B | Checker exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Red head `0703c436` | 118 | 1129563 | 329740 | 329472 | 1 |
| Fixed build 1 | 116 | 1128578 | 329084 | 329472 | 0 |
| Fixed clean build 2 | 116 | 1128580 | 329085 | 329472 | 0 |

Both fixed builds include the retained encoding check. Every client JS/CSS path
and SHA-256 and the Worker entry bytes match the red build. The actual emitted
loaders, member-read boundary and Svelte renderers were compared against synthetic
fixtures in both fixed builds: 19 archive/detail/error states retain identical
HTML and headers (detail audit counts also match); three malformed-query states
now correctly render All events instead of repaired search results. Only the
Workers environment binding is substituted. This is not a Workerd, hook, browser,
staging or production proof. No screenshots or broad gates are claimed fresh by
these emitted-byte checks. Undo the grouping by reverting the Vite configuration
change; keep the parser check and its regression test.

## Verification boundary

The independently authored acceptance files from commit
[`714e382c`](https://github.com/TogetherWeOwn/two-web-next/commit/714e382c164509eaa06a60490509820f17b6f6ee)
are consumed unchanged. They cover both real archive/detail twins, exact row
identity, hostile context, member audit/refusal and clean share destinations.
Additional implementation-owned tests pin boundary edge cases and live-read
forwarding against both source and minified island bytes.

Local fixture/browser evidence is not deployment proof. Hono accessibility and
Lighthouse gates do not exercise Kit routes; the Kit captures and browser checks
above are separate evidence. The pinned visual specs must run in GitHub Actions;
the local runner guard is not bypassed. No baseline, quality threshold, raw/gzip
budget or gate is relaxed. Exact-head CI and independent review precede the
existing [release contract](releases.md). A regression is undone by reverting
this single PR, with no destructive data change.
