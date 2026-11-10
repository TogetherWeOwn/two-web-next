# Board captions and empty-state recovery evidence

## Design contract

- **Audience and screen job:** a signed-in member reading the member leaderboard must know which board they see (their neighborhood or the overall top 100) and, when unranked, how to get ranked.
- **Primary action:** ranked readers keep reading; unranked readers follow the overall-board link or the events link. No new write, no new navigation chrome.
- **Content and references:** the existing [Hono board page](../../../src/leaderboards/pages.tsx) and [Kit board page](../../../web/src/routes/leaderboards/members/+page.svelte) are the reference; no new visual direction. Copy names the scope plus the window math ("Around you (5 above and below)", "Overall (ranks 1–100)") and keeps the season and game labels. Empty states name the ranked path ("answer going to get ranked") and link the overall scope or clear the game filter.
- **Layout, typography and tokens:** unchanged. Caption stays a table caption; empty states stay a single `role="status"` paragraph. At 1280×800 and 390×844 the existing responsive flow must remain usable without horizontal overflow.
- **Required states:** relative rows, overall rows, relative empty, overall empty (with and without a game filter), on both twins.
- **Non-goals:** ranking math, friends scope, per-game drill-down, board-view logging, grammar or layout changes.
- **Guardrail:** rank and count only. No profile links anywhere in the new copy or links.

## Captures

After-state captures of the real rendered pages with fixture identities ("Caption viewer", "Board alpha/beta") at the implementation head. Shipped bytes are unchanged between capture and this head (only test files moved), and every image below was opened and reviewed at this head.

| State | Hono 1280 | Hono 390 | Kit 1280 | Kit 390 |
| --- | --- | --- | --- | --- |
| Relative rows | [Image](hono-relative-rows-1280.png) | [Image](hono-relative-rows-390.png) | [Image](kit-relative-rows-1280.png) | [Image](kit-relative-rows-390.png) |
| Overall rows | [Image](hono-overall-rows-1280.png) | — (same shell as relative) | [Image](kit-overall-rows-1280.png) | — (same shell as relative) |
| Relative empty | [Image](hono-relative-empty-1280.png) | — (single paragraph, wraps) | [Image](kit-relative-empty-1280.png) | — (single paragraph, wraps) |
| Overall empty | [Image](hono-overall-empty-1280.png) | — (single paragraph, wraps) | [Image](kit-overall-empty-1280.png) | — (single paragraph, wraps) |

Twin parity holds by eye: identical captions and identical empty-state sentences on both twins. The overall-empty state with no game filter shows only the events link (there is no filter to clear); with a game filter it also offers "show every game". No visual-regression baseline was changed.

Repeatable behavior proofs live in `test/member-board-captions-empty-recovery-acceptance.test.ts` (20 tests, both twins, both scopes).
