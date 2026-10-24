# RSVP pause review evidence

Synthetic local fixtures only. Each sheet shows before, initially closed and
expanded review, with desktop 1280x800 on the left and mobile 390x844 on the
right. The viewport scrolls to the affected control; event-list captures scroll
its existing labelled table region to the Actions column, and expanded captures
align the review card to the viewport top so the final submit is visible.

| Presentation | Event list | Event editor |
| --- | --- | --- |
| Hono | [Before / closed / expanded](hono-event-list.png) | [Before / closed / expanded](hono-event-edit.png) |
| Kit | [Before / closed / expanded](kit-event-list.png) | [Before / closed / expanded](kit-event-edit.png) |

Before source: `c0e1582bd`. After implementation: `b2318a116`. The real Hono
JSX pages and real compiled Svelte SSR pages use the independent synthetic
saved-row fixtures in `test/helpers/admin-rsvp-pause-review.ts`; browser
document and asset requests are intercepted locally and non-GET requests are
blocked during capture. The screenshot transport supplies UTF-8 content type
and the Kit document wrapper's language, rather than changing page source to
satisfy an audit. The Kit review is inlined in both pages rather than shared
through a component (a shared chunk breaches the client file-count ceiling);
the rendered markup, classes and copy are identical on both renderers.

All 24 underlying screenshots were opened for inspection. The four sheets
compose those screenshots without scaling. Capture observed zero mutation
requests. Eight expanded-state axe WCAG 2 A/AA and WCAG 2.1 A/AA checks found
zero violations. The list review keeps a 16rem minimum width so the closed
summary stays readable on mobile.

The UI reuses the existing admin shell, system-font declaration, ink/paper/
brand/muted colors, native focus and table scrolling. Font availability differs
from the pinned CI visual runner. These are inspectable fixture screenshots,
not accepted visual-regression baselines, a pixel-comparison PASS, or
deployment proof. No regression baselines, masks or thresholds were changed.
The repository Hono accessibility/Lighthouse gates and pinned Hono/Kit visual
checks remain separate required checks; they do not substitute for Kit runtime
evidence.
