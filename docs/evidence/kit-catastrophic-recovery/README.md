# Catastrophic Kit recovery page: visual evidence

Standalone `web/src/error.html` fallback, rendered offline with status 500 and
a synthetic-only failure message. No live error, member data, session, or
network. The original implementation author opened the initial captures below.

## Compact shell design contract

The audience, job and actions are unchanged: someone stranded before Kit can
render must recognize the site and failure, then recover through Home or Events.
The references remain the lobby's dark/light/lime tokens and the normal
ErrorShell's native recovery anchors. The shell keeps a centered, readable
35rem content column, 1.5rem horizontal padding, 16px system text and a visible
3px keyboard outline. Underlined links replace the initial button treatment;
short generic copy replaces the longer explanation. Native forced-colors
adjustment remains enabled. No script, font, stylesheet, session or data fetch
is needed. Normal Kit errors, themes and live failure injection remain out of
scope.

The inline document is deliberately compact because SvelteKit embeds it in a
client JS chunk. The initial shell plus current main exceeded the existing
client budget (237290 raw / 95696 gzip against 236032 / 95232). The compact
shell fits those same ceilings; no budget or dependency changes are needed.
The acceptance tests remain byte-identical. The current captures below replace
the initial presentation as evidence of the PR head.

## Current compact shell

Captured with the unchanged offline browser suite (16/16 passed, including
axe with zero WCAG AA violations). All nine current images were opened.

| Viewport | Current | Home focused | Events focused |
| --- | --- | --- | --- |
| Desktop 1280×800 | [Current](compact-desktop.png) | [Home](compact-desktop-focus-home.png) | [Events](compact-desktop-focus-events.png) |
| Mobile 390×844 | [Current](compact-mobile.png) | [Home](compact-mobile-focus-home.png) | [Events](compact-mobile-focus-events.png) |
| Forced colors 390×844 | [Current](compact-forced-colors.png) | [Home](compact-forced-colors-focus-home.png) | [Events](compact-forced-colors-focus-events.png) |

## Initial shell (superseded)

Retained to show the earlier presentation, not the current PR head.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop 1280×800 | [Before](before-desktop.png) | [After](after-desktop.png) |
| Mobile 390×844 | [Before](before-mobile.png) | [After](after-mobile.png) |
| Forced colors 390×844 | [Before](before-forced-colors.png) | [After](after-forced-colors.png) |

Keyboard focus, captured after Tab-navigation to each recovery anchor:

| Viewport | Focus |
| --- | --- |
| Desktop, Home focused | [After](after-desktop-focus-home.png) |
| Mobile, Events focused | [After](after-mobile-focus-events.png) |
| Forced colors, Home focused | [After](after-forced-colors-focus-home.png) |

Before: bare status heading plus the raw synthetic failure text, no site
identity, viewport, or recovery links. After: branded shell with status
heading, generic copy, and plain Home/Events anchors. The synthetic sentinel
visible in the before captures never appears in the after captures.

## Capture boundary

`e2e/kit-catastrophic-fallback.spec.ts` mounts the template bytes with literal
status substitution, blocks service workers, sets the context offline, and
fulfills only the fixture document plus inert Home/Events destinations. No
application CSS, font, image, or layout is injected. JavaScript is disabled for
these captures. The container has no system sans-serif fonts, so text renders
in its fallback serif; real systems render the declared system stack.

Current focus outlines inherit the link color: lime normally and the system
link color in forced colors. Native forced-colors adjustment replaces the page
colors without a separate media rule. The Hono a11y/Lighthouse/visual gates do
not exercise this Kit fallback; its own browser suite (16 cases, including an
axe WCAG AA pass) is the accessibility evidence.
