# Featured effective-state evidence

## Design contract

- Audience: moderators browsing saved featured slots in `/admin/featured`.
- Screen job: find slots by effective state (eligible now, scheduled, expired,
  unpublished, unavailable) and open a slot's existing edit destination. The
  primary action is the native GET filter form; no new action is introduced.
- Real content: saved slots, including rows whose stored window cannot be
  decoded (infinite or out-of-range bounds). Those rows stay inspectable with
  their exact saved bound text and an `unavailable` verdict, never a live one.
- References: the existing `FeaturedPage` filter form and the RSVP-roster
  answer facet (exact allowlist, `All` reads as absent). No new visual
  direction; Open Lobby type/tokens and the current Hono/SvelteKit route stack.
- Layout: one `Effective state` select after `Published` in the filter form;
  one guidance paragraph under the form; unchanged sortable wide table, pager
  and keyboard-scroll region. The new `unavailable` badge uses the brand color
  to signal "inspect the saved bounds".
- Responsive: 1280×800 and 390×844. Filters wrap; the table keeps its existing
  horizontal scroll region with the scroll hint.
- Required states, all rendered and opened: normal, state-filtered empty, and
  undecodable-window inventory, on both renderers and both widths, JavaScript
  on/off for normal, keyboard-only Filter/Clear/no-JS.
- Non-goals: guest homepage selection, publication/write policy, data repairs,
  browse-return context, thresholds, budgets and baselines wholesale.

## Captures

The `after-*` captures use the real Hono route renderer and the real compiled
Kit loader/leaf with local intercepted fixtures and public assets. The
`before-*` captures are the same scenes on the pre-change tree. Chromium uses
local system fonts; these are visual evidence, **not pinned-runner baselines**.
Every listed image was opened after capture.

| Scene | Hono 1280×800 | Hono 390×844 | Kit 1280×800 | Kit 390×844 |
| --- | --- | --- | --- | --- |
| Normal | [after](after-hono-1280-normal.png) ([before](before-hono-1280-normal.png)) | [after](after-hono-390-normal.png) ([before](before-hono-390-normal.png)) | [after](after-kit-1280-normal.png) | [after](after-kit-390-normal.png) |
| Undecodable window | [after](after-hono-1280-unavailable.png) ([before](before-hono-1280-unavailable.png)) | [after](after-hono-390-unavailable.png) | [after](after-kit-1280-unavailable.png) ([before](before-kit-1280-unavailable.png)) | [after](after-kit-390-unavailable.png) |
| Filtered empty | [after](after-hono-1280-empty.png) | [after](after-hono-390-empty.png) | [after](after-kit-1280-empty.png) | [after](after-kit-390-empty.png) |

Before the change the normal scenes lack the facet and the guidance, and the
undecodable scenes fail outright (Hono answers its shared 503 envelope; the
Kit loader rejects before rendering). After the change every scene renders
both siblings with exact saved text, the `unavailable` badge and the existing
edit links, and the filtered-empty scene names the filters with a Clear link.

The `after-hono-sql-*` captures render the same Hono route through real SQL
against a disposable schema seeded with one row per state (open live,
scheduled, expired-window, unpublished draft, infinite bound):
[1280×800](after-hono-sql-1280.png) and [390×844](after-hono-sql-390.png).
Badges match the seeded windows at the capture instant; the "expired" seed
reads live because its 2032 end is future relative to the real capture clock.

The Kit captures execute the actual loader and compiled leaf with real leaf
head/styles/islands, not the complete Kit root layout/theme initialization;
the default-theme contrast in that fixture is not a visual approval. Hono
a11y/Lighthouse/quality gates do not exercise Kit routes.
