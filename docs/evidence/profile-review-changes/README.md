# Profile unsaved-change review — visual evidence

## Design contract

- Audience: a member editing their own profile (the editor is owner-only).
- Screen job: let the member check exactly what would change before they
  press Save. Save stays the primary action; the review is an optional
  inline disclosure under Save/Cancel, never a confirmation gate.
- Real content: the four editable values (bio, games, timezone,
  leaderboard visibility), each shown as Saved vs Unsaved. A cleared field
  reads "Removed — will be empty"; the leaderboard choice is spelled out
  ("Shown on the leaderboard (opted in)" / "Hidden from the leaderboard
  (opted out)"), never a boolean. A clean form reads "No unsaved changes —
  this form matches your saved profile."
- Layout, type, tokens: existing profile editor and Open Lobby styling
  only — a native `<details>`/`<summary>` ("Review changes") and a bordered
  panel reusing `profile-theme.css` surface, line and ink tokens. No new
  visual direction, no framework change on either renderer.
- Responsive: the disclosure and panel sit in the single-column editor
  measure at both 1280px and 390px; long values wrap (`pre-wrap`,
  `overflow-wrap: anywhere`).
- Required states: clean, each field changed, every text field cleared
  (removal), a review opened while a save is pending with newer edits,
  and the native-422 rejected draft against the saved baseline. No-JS
  keeps the complete ordinary edit form; the disclosure then shows the
  server-rendered comparison for the values the page was rendered with.
- Non-goals: no validation, no normalization of the live draft, no save,
  no autosave or draft storage, no new fields or visibility policy.

## How these were captured

Local Chromium against the in-memory participation fixture (no database,
no network) via the acceptance suite, with `PROFILE_REVIEW_EVIDENCE_DIR`
set; every image below was opened during review of the change:

```sh
PROFILE_REVIEW_EVIDENCE_DIR=<dir> node --import tsx --test \
  ci/profile-review-changes-browser.test.mjs
```

"Before" images are the same fixture rendered from the base tree (the
editor ends at Save/Cancel; there is no disclosure). "After" images come
from the full 104-case run on the feature head (both renderers, both
widths).

## Index

| State | Hono 1280 | Hono 390 | Kit 1280 | Kit 390 |
| --- | --- | --- | --- | --- |
| Before (clean editor) | before-clean-Hono-1280.png | before-clean-Hono-390.png | before-clean-Kit-1280.png | before-clean-Kit-390.png |
| After, clean review | after-clean-Hono-1280.png | after-clean-Hono-390.png | after-clean-Kit-1280.png | after-clean-Kit-390.png |
| After, bio changed | after-changed-Hono-1280.png | after-changed-Hono-390.png | after-changed-Kit-1280.png | after-changed-Kit-390.png |
| After, fields cleared | after-removal-Hono-1280.png | — | — | after-removal-Kit-390.png |
| After, rejected draft | — | after-rejected-Hono-390.png | after-rejected-Kit-1280.png | — |
| After, pending save | after-pending-Hono-1280.png | — | — | after-pending-Kit-390.png |
