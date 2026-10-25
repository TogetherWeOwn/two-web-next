# Calendar game recovery: local visual evidence

Synthetic fixtures rendered through the real Hono route and Kit events loader/HTML
adapter. No live service or database was used. Both adapters produce byte-identical
screenshots for every pair below; the single set avoids storing duplicate images.
All 24 twin captures represented here were opened for visual review.

Viewport sizes: desktop **1280×800**, mobile **390×844**. Images capture the full page
at those viewport sizes. Typography, Open Lobby/Logo 1, layout and semantic tokens
are unchanged. These images are evidence, not visual-regression baselines.

| State | Desktop before / after | Mobile before / after |
| --- | --- | --- |
| Committed Chess + text query, failed Go read | [Before](before-failure-1280.png) / [After](after-failure-1280.png) | [Before](before-failure-390.png) / [After](after-failure-390.png) |
| No upcoming Chess events; historical Chess exists | [Before](before-game-empty-1280.png) / [After](after-game-empty-1280.png) | [Before](before-game-empty-390.png) / [After](after-game-empty-390.png) |
| No matches for text query within Chess | [Before](before-combined-empty-1280.png) / [After](after-combined-empty-1280.png) | [Before](before-combined-empty-390.png) / [After](after-combined-empty-390.png) |

Additional global-empty and partial-Discord states were captured and opened at both
widths for both adapters. Their before/after rendering is unchanged. Axe reported
zero serious/critical violations across all 40 before/after fixture captures. Real
Chromium acceptance separately exercises source and shipped island bytes, keyboard
retry/Dismiss, cooldown, newer edits, atomic admission, history and native no-JS GET.
The Hono a11y/Lighthouse gates do not exercise Kit routes. No intentional baseline
change, extra masking or threshold/budget change is included here.
