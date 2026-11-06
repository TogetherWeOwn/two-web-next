# Saved-event review evidence

## Implementation contract

Moderators inspect the persisted member detail rendering, then return to edit
or publish. Reuse the existing Hono and Kit detail renderers, typography, content
width, tokens, notices and buttons. Moderator chrome adds a banner above and
non-sticky actions below; it must not inset or restyle member content.
References: the existing member detail pages and moderator event editor.
No new framework, tokens, inline editor, sharing permission or approval workflow.

Required states: ready draft, corrections needed, unavailable update timestamp,
unsaved editor changes, non-draft, stale record and publish failure. Correction
links return to editor fields; RSVP is disabled in preview. Both desktop
1280×800 and mobile 390×844 need real-app captures opened for visual review.

## Historical captures — not evidence for the corrected UI

The six PNGs in this directory show the superseded advisory editor section,
not the member-detail review mode. They are retained for the before comparison
only. They do not verify the current candidate, Kit parity or publish-from-view.

New screenshots and exact-head GitHub Actions evidence are still pending.
No current visual, accessibility, performance or CI pass is claimed here.
The Hono gates do not exercise the Kit route; Kit needs its own screenshots.

The existing Actions `a11y` job captures the Hono review/notice routes. Its
`ci/event-time-from-now.test.mjs` fixture harness also captures both actual detail
renderers at both widths, ready/corrections/published/cancelled, under
`artifacts/a11y/saved-review/` in `a11y-evidence`. No baseline is accepted by these
captures. Publish-from-review, stale mutation and publish failure belong to the
second slice; this candidate is read-only. Artifact inspection is still pending.
