# Profile scheduled-game links: visual evidence

## Design contract

- **Audience and job:** signed-in members viewing their own or another member's
  profile want to find a night for a game they play. Follow a game name to its
  explicitly scoped schedule.
- **Content:** stored `chess `, Stardew Valley, D&D, and an unmatched free-text
  game. Shared markers remain siblings of the linked name.
- **References:** the existing [profile view](../../../src/profiles/pages.tsx),
  [shared-game matcher](../../../src/profiles/shared-games.ts), and
  [schedule facet](../../../src/islands/contracts-calendar.ts) are the visual and
  behavioral references. No new visual direction.
- **Layout, typography, tokens:** unchanged cards, game chips, site link colors,
  underlines and focus styling. No new CSS or client JavaScript.
- **Responsive behavior:** keep the existing flow and wrapping at 1280×800 and
  390×844. Images are full-page captures at those viewport sizes.
- **States:** other member with shared and unshared matches; owner's linked games
  without shared markers; public-game read failure with the original plain list;
  and a member listing no games.
- **Non-goals:** Steam import, a canonical game registry, upcoming-event counts,
  profile editing changes, or layout changes.

## Opened screenshots

Every linked image was captured and opened for visual review. These use real
Hono profile requests with memory session/profile stores and the real Kit profile
model plus SSR-compiled ProfileView, serving the repository's public assets. The
only data is local fixtures. JavaScript was disabled during capture. Kit's
standalone SSR fixture omits the app-shell dark-theme attribute, so its pairs
show the existing light theme; the Hono pairs show dark. No baseline was accepted
or regenerated.

| Twin / state | Desktop | Mobile |
| --- | --- | --- |
| Hono before | [1280×800](before/hono-other-desktop.png) | [390×844](before/hono-other-mobile.png) |
| Hono after | [1280×800](after/hono-other-desktop.png) | [390×844](after/hono-other-mobile.png) |
| Kit before | [1280×800](before/kit-other-desktop.png) | [390×844](before/kit-other-mobile.png) |
| Kit after | [1280×800](after/kit-other-desktop.png) | [390×844](after/kit-other-mobile.png) |
| Hono owner | [1280×800](after/hono-owner-desktop.png) | [390×844](after/hono-owner-mobile.png) |
| Kit owner | [1280×800](after/kit-owner-desktop.png) | [390×844](after/kit-owner-mobile.png) |
| Hono read failure | [1280×800](after/hono-failure-desktop.png) | [390×844](after/hono-failure-mobile.png) |
| Kit read failure | [1280×800](after/kit-failure-desktop.png) | [390×844](after/kit-failure-mobile.png) |
| Hono no games | [1280×800](after/hono-empty-desktop.png) | [390×844](after/hono-empty-mobile.png) |
| Kit no games | [1280×800](after/kit-empty-desktop.png) | [390×844](after/kit-empty-mobile.png) |

The changed names are visibly underlined links; unknown free text remains plain.
Shared chips and responsive wrapping stay in place. The read-failure captures
match the pre-change profile appearance.

These captures prove fixture rendering, not a staging or production deployment.
The repository's a11y and Lighthouse commands exercise Hono, not Kit routes.
Pinned-runner visual comparisons and deployed verification remain separate
release evidence.
