# Truthful subscribe controls: visual evidence

## Design contract

- Audience: a signed-out member deciding how to follow the community calendar.
- Screen job: the "How to subscribe to the calendar" block tells them which
  control to use, in words that match the control that actually renders.
- Primary action: unchanged (click Subscribe, or copy the feed URL).
- Layout, typography, tokens: unchanged. This change edits words, link order
  and test-only attributes only.
- Required states: help block collapsed (default) and open, at desktop
  (1280x800) and mobile (390x844), on all three subscribe surfaces plus the
  FAQ answer that shares the copy source.
- Non-goals: new channels, feed URL scheme, island rewrite, visual redesign.

## Decisions

- Guidance names the rendered control: "choose Subscribe" (was "choose
  Subscribe to calendar"). The link label stays "Subscribe".
- One feed-link order everywhere: Subscribe, RSS feed, Download calendar
  (.ics). The calendar head adopts the archive order, so subscription methods
  precede the one-time import.
- One manual-copy line everywhere: "Select the feed URL and copy it manually
  in your calendar app." The static paragraph adopts the toast wording, so the
  toast and the static instruction agree verbatim.
- The help block gains test-only `data-testid` attributes; they change no
  pixel. The no-JS path is unchanged (readonly selectable input, hidden copy
  button).

## Captures

Captured and opened on 2026-10-21 using actual Hono SSR and Kit SSR output,
local empty-calendar fixtures, and served local assets. No real member,
calendar provider, clipboard permission grant, or external service was used.
Before captures render base `eabe55b4`; after captures render this change.
The open state is a real click on the disclosure summary. Every panel below
was opened and read.

Each surface sheet stacks four viewport captures top to bottom: before
collapsed, after collapsed, before open, after open. Each FAQ sheet stacks
two: before, after. Closed archive captures are pixel-identical before and
after (verified with `cmp`); only the calendar-head link order and the
guidance/manual-copy words change anywhere.

| Surface | Desktop (1280x800) | Mobile (390x844) |
| --- | --- | --- |
| Hono calendar | [Sheet](hono-calendar-desktop.jpg) | [Sheet](hono-calendar-mobile.jpg) |
| Hono archive | [Sheet](hono-archive-desktop.jpg) | [Sheet](hono-archive-mobile.jpg) |
| Kit archive | [Sheet](kit-archive-desktop.jpg) | [Sheet](kit-archive-mobile.jpg) |
| Hono FAQ subscribe answer | [Sheet](faq-hono-desktop.jpg) | [Sheet](faq-hono-mobile.jpg) |

Kit archive captures serve the same stylesheets as the Hono captures plus the
charset from the real Kit document shell. The Kit FAQ answer is covered by the
shared-copy parity tests rather than a sheet. These are manual visual
evidence, not replacements for the pinned-runner visual baseline comparisons.
