# Published game name suggestions

The member leaderboard's Game filter and moderator event create/edit Game fields
suggest spellings already used by published events. Suggestions include historical
events: they do not promise current players, future events or available seats.

These are ordinary text inputs backed by native datalists. You can type a new name,
including a game literally named `All`. Selecting or editing a name does not submit
anything. Use **Show board**, **Create draft** or **Save** explicitly. The existing
game validation and matching rules remain unchanged.

Each admitted, valid GET reads the existing published-only catalog once, capped at
100 distinct names. No profile or per-game member lookup is added. A classified
catalog outage removes assistance without removing the existing board or editor.
Other errors still use the existing diagnostics and refusal behavior. Rejected
moderator writes keep their exact drafts and existing no-extra-read behavior;
refreshing an editor GET obtains a new suggestion snapshot.

## Design contract

- **Audience and job:** members finding a game board; moderators reusing a published
  spelling while creating or editing an event. The explicit action remains primary.
- **References and assumptions:** the existing member board, moderator event editor
  and their SvelteKit twins. Keep their current Open Lobby/Logo 1 direction,
  typography, layout and tokens. Do not introduce a new visual system.
- **Content and states:** Chess/chess variants, historical names, All, punctuation,
  Unicode and escaped hostile labels; populated and unavailable catalogs; invalid
  board filters; rejected, stale-session and pending editor drafts.
- **Responsive and interaction:** native browser assistance at 1280×800 and 390×844;
  keyboard editing and explicit submission with and without JavaScript.
- **Non-goals:** aliases, taxonomy, ranking changes, attendance/availability promises,
  role or profile changes, Steam data, autosave, storage and new islands.

## Local fixture visual evidence

Each labelled sheet contains desktop and mobile captures for normal, catalog
fallback and error states. The before and after sheets were opened for visual
review. The board hint inherits the page's readable text color instead of the
light-theme-only global hint color. No visual baseline or threshold was changed.

| Renderer / screen | Before | After |
| --- | --- | --- |
| Hono board | [Before](evidence/game-inputs/before-Hono-board.png) | [After](evidence/game-inputs/after-Hono-board.png) |
| Hono create | [Before](evidence/game-inputs/before-Hono-create.png) | [After](evidence/game-inputs/after-Hono-create.png) |
| Hono edit | [Before](evidence/game-inputs/before-Hono-edit.png) | [After](evidence/game-inputs/after-Hono-edit.png) |
| Kit board | [Before](evidence/game-inputs/before-Kit-board.png) | [After](evidence/game-inputs/after-Kit-board.png) |
| Kit create | [Before](evidence/game-inputs/before-Kit-create.png) | [After](evidence/game-inputs/after-Kit-create.png) |
| Kit edit | [Before](evidence/game-inputs/before-Kit-edit.png) | [After](evidence/game-inputs/after-Kit-edit.png) |

The fixtures execute real Hono routes and compiled Kit loads/pages with doubled
persistence and Workers bindings. They do not use live member records or external
requests. Kit captures are standalone compiled page/shell fixtures, not the entire
deployed root-layout application; the existing fixture theme differs between twins.
The local browser lacks a CJK fallback glyph in some inputs; DOM and request
assertions verify the exact Unicode strings. Native association and keyboard edits
are checked, not the operating system's datalist popup pixels.

The existing Hono accessibility/Lighthouse/visual gates do **not** exercise Kit
routes. Local fixture screenshots are separate evidence, not approval of baseline
changes or proof of deployment. The PR verification section records actual gate
results and remaining limitations.
