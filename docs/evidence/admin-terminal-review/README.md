# Native terminal-action review evidence

Synthetic local fixtures only. Each sheet shows before, initially closed and
expanded review, with desktop 1280×800 on the left and mobile 390×844 on the right.
The viewport scrolls to the affected control; event-list captures scroll its
existing labelled table region to the Actions column.

| Presentation | Event list | Event editor | Featured editor |
| --- | --- | --- | --- |
| Hono | [Before / closed / expanded](hono-event-list.png) | [Before / closed / expanded](hono-event-edit.png) | [Before / closed / expanded](hono-featured-edit.png) |
| Kit | [Before / closed / expanded](kit-event-list.png) | [Before / closed / expanded](kit-event-edit.png) | [Before / closed / expanded](kit-featured-edit.png) |

Before source: `4c904d1ff656aa88512fb90bb02018b95cf7778d`. After implementation:
`ad1662d172bc460724ef2f701c8ba16808eaa9cc`. Later acceptance-fixture changes do
not change the captured production markup or stylesheet. The real Hono JSX
pages and real compiled Svelte SSR pages use the independent synthetic saved-row
fixtures in `test/helpers/admin-terminal-review.ts`; browser document and asset
requests are intercepted locally and non-GET requests are blocked during capture.
The screenshot transport supplies UTF-8 content type and the Kit document wrapper's
language, rather than changing page source to satisfy an audit.

All 36 underlying screenshots were opened for inspection. The six sheets compose
those screenshots without scaling. Capture observed zero mutation requests.
Twelve expanded-state axe WCAG 2 A/AA and WCAG 2.1 A/AA checks found zero violations.
The list review has a 16rem minimum width after inspection caught an excessively
narrow closed summary on mobile; the featured review uses existing action spacing
after inspection caught it touching the Save row.

The UI reuses the existing admin shell, system-font declaration, ink/paper/brand/
muted colors, native focus and table scrolling. Font availability differs from
the pinned CI visual runner. These are inspectable fixture screenshots, not
accepted visual-regression baselines, a pixel-comparison PASS, or deployment
proof. No regression baselines, masks or thresholds were changed. The repository
Hono accessibility/Lighthouse gates and pinned Hono/Kit visual checks remain
separate required checks; they do not substitute for Kit runtime evidence.
