# Catastrophic Kit recovery page: visual evidence

Standalone `web/src/error.html` fallback, rendered offline with status 500 and
a synthetic-only failure message. No live error, member data, session, or
network. The implementation author opened every image below.

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

Focus outlines are white in the normal presentation and the system highlight
in forced colors. The Hono a11y/Lighthouse/visual gates do not exercise this
Kit fallback; its own browser suite (16 cases, including an axe WCAG AA pass)
is the accessibility evidence.
