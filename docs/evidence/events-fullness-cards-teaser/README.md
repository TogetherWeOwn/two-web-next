# Fullness on calendar cards and the home teaser: visual evidence

Full events are marked on the schedule and the home teaser without opening
each event. Full rows read `N of M going · Full`; open capped rows read
`N of M going`; uncapped rows keep the bare `N going`.

## Matrix

Fixtures: one full capped night (2 of 2), one open capped night (1 of 4),
one uncapped open house (3 going). Hono pages render through the real app
with pg-proxy fixtures; the Kit page renders the real `+page.svelte`
through the SSR harness with the built token stylesheet. Every image was
opened and checked.

| Page | Before | After |
| --- | --- | --- |
| `/events` desktop (1280x800) | `before-events-desktop.png` | `after-events-desktop.png` |
| `/events` mobile (390x844) | `before-events-mobile.png` | `after-events-mobile.png` |
| `/` desktop | `before-home-desktop.png` | `after-home-desktop.png` |
| `/` mobile | `before-home-mobile.png` | `after-home-mobile.png` |
| Kit `/` desktop | `before-kit-home-desktop.png` | `after-kit-home-desktop.png` |
| Kit `/` mobile | `before-kit-home-mobile.png` | `after-kit-home-mobile.png` |

The `/events?past=1` and `/events/past` renders are byte-identical before
and after: past and archive cards stay unmarked.
