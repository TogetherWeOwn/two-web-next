# Event card host: visual evidence

## Design contract

Audience: guests and members scanning the schedule, the calendar list and
the archive. Screen job: name the organizer without opening the detail
page. Primary action: none — the host line is plain text, never a link.

Keep the Open Lobby/Logo 1 chrome, semantic tokens, typography, date badge,
attendance count and sign-in actions. Add one compact secondary line,
`Hosted by {name}`, inside the existing `.schedule-info` block, after the
game line and before the badges. The name is the trimmed public
`organizer_name` — the same field the detail page shows — so blank or
missing renders no node at all. References: the detail `Hosted by` block
and the existing card game line; no new visual direction. Required states:
hosted, unhosted (no node), hostile markup (escaped), long Unicode (wraps),
cancelled (badge plus host, no sign-in), transient (no node), past (host
shown, actions suppressed). Non-goals: host profile link, host filter, host
editing, new reads or indexes, detail changes, cutover or budget changes.

## Captures

Real Chromium (Playwright), JavaScript disabled, real SSR bytes per route at
1280x800 and 390x844 viewports plus 390-wide card close-ups. Hono pages
render through the app router on hermetic pg-proxy fixtures; the Kit
archive page is the real compiled SvelteKit page plus server load. Before
shots use the same fixtures and command on the pre-change tree. Every
image in this directory was opened and inspected.

Limits: container font fallback can differ from the pinned CI runner (CJK
glyphs in the long-host fixture render as boxes here), so these captures
are implementation evidence, not golden-baseline approval. The Kit archive
shots render light/unthemed because the SSR harness omits the app-shell
theme attribute; before/after pairs stay self-consistent. Keyboard
verification is by DOM count, not Tab order: the focusable-element count
is identical before and after (schedule 31/31, archive 20/20) and the host
`<p>` carries no tabindex, link or island. No-JS holds by construction:
the shots are static server HTML rendered with scripting disabled.

## Pairs

| Route | Width | Before | After |
| --- | --- | --- | --- |
| Hono schedule | 1280 | [before](before/schedule-1280.png) | [after](after/schedule-1280.png) |
| Hono schedule (full page, all five states) | 1280 | [before](before/schedule-1280-full.png) | [after](after/schedule-1280-full.png) |
| Hono schedule header | 390 | [before](before/schedule-390.png) | [after](after/schedule-390.png) |
| Hono schedule card | 390 | [before](before/card1-390.png) | [after](after/card1-390.png) |
| Hono schedule long-host card | 390 | [before](before/card-long-390.png) | [after](after/card-long-390.png) |
| Hono archive | 1280 | [before](before/archive-h-1280.png) | [after](after/archive-h-1280.png) |
| Hono archive | 390 | [before](before/archive-h-390.png) | [after](after/archive-h-390.png) |
| Hono archive card | 390 | [before](before/arch-card1-390.png) | [after](after/arch-card1-390.png) |
| Hono archive long-host card | 390 | [before](before/arch-card-long-390.png) | [after](after/arch-card-long-390.png) |
| Kit archive | 1280 | [before](before/archive-k-1280.png) | [after](after/archive-k-1280.png) |
| Kit archive | 390 | [before](before/archive-k-390.png) | [after](after/archive-k-390.png) |

What changed between before and after: hosted cards gain one `Hosted by
{name}` line after the game line; unhosted cards render nothing extra.
Chrome, badge, attendance, actions, typography, footer and both widths'
layouts are otherwise unchanged. The inserted bytes are exactly the host
paragraphs (verified by stripping `<p data-testid="event-card-host">…</p>`
from the after HTML and byte-comparing against before; the Kit page adds
only Svelte `{#if}` hydration anchors).
