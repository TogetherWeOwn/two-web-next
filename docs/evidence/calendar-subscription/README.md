# Calendar subscription help: visual evidence

Captured and opened on 2026-10-20 using actual Hono and Kit SSR templates,
local empty-calendar fixtures, and intercepted local assets. No real member,
calendar provider, clipboard permission grant, or external service was used.
Before captures render base `9d6f8a6d7`; after captures render this change.

Each sheet includes eight full-page captures at the named viewport:
before; after collapsed, open, pending clipboard, confirmed copy, denied copy;
and no-JavaScript collapsed/open. The source PNGs were inspected through the
sheets and the pending images were also opened individually. All captures
reported no horizontal document overflow. These are manual visual evidence,
not replacements for the pinned-runner visual baseline comparisons.

| Surface | Desktop (1280×800) | Mobile (390×844) |
| --- | --- | --- |
| Hono calendar | [Sheet](hono-calendar-desktop.jpg) | [Sheet](hono-calendar-mobile.jpg) |
| Hono archive | [Sheet](hono-archive-desktop.jpg) | [Sheet](hono-archive-mobile.jpg) |
| Kit calendar (shared Hono renderer) | [Sheet](kit-calendar-desktop.jpg) | [Sheet](kit-calendar-mobile.jpg) |
| Kit archive | [Sheet](kit-archive-desktop.jpg) | [Sheet](kit-archive-mobile.jpg) |

Kit archive captures include the built Kit app stylesheet and the charset and
viewport from its real document shell. Its independent acceptance helper does
not include those shell pieces; that helper remains unmodified. Calendar help
stays outside the calendar fragment zones; archive help stays outside the
state/list/pager zones. The no-JS field remains selectable without a copy button.

The existing Hono accessibility and Lighthouse gates do not exercise the Kit
archive route. Browser acceptance covers its native controls separately. No
changed staging or production behavior is claimed by these local images.
