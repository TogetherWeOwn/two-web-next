# Admin save feedback: fixture evidence

## Design contract

Moderators need to save an event or featured draft once, understand a pending
navigation, and check the saved record before resubmitting an unconfirmed write.
Reuse the current admin layout, inherited typography and colors. Keep the status
adjacent to Save but outside its busy form. Use polite, atomic text with no focus
movement. Let it wrap naturally on mobile; do not introduce a panel or overlay.

References are the existing admin form, validation-summary and session-expiry
patterns: adapt their explicit next steps, but not alert semantics or focus capture
for routine progress. Required states are idle, pending, explained repeat,
unconfirmed at the existing ten-second bound, and pageshow reset. Dirty drafts,
expiry recovery and native no-JS submission remain intact. No AJAX, automatic
retry, new persistence, auth policy or timeout extension.

Copy lives only in the shared editor island. It says “Saving… Please wait.”,
“Already saving. Please wait.”, or “Saving is not confirmed. Check the saved record
before resubmitting.” The last message does not declare a failed or successful
write. The document retains the draft; navigation can still discard it.

## Capture boundary

These are actual Hono and Svelte server-rendered form fixtures, not replacement
markup. All eight event/featured create/edit presentations were captured at
1280×800 and 390×844. The images below are representative event-create and
featured-edit captures; the full set is retained with the QA execution evidence.
The state sheets contain the original viewport captures in order: idle, pending,
repeat, unconfirmed, pageshow. Desktop panels are scaled to half size in the
sheets; mobile panels retain their original size.

Kit leaf compilation omits the root layout/head. The capture applies the real
shared admin stylesheet and the built Kit canvas stylesheet to both base and head.
It is not a hydrated Kit-server journey. Native POST transport is interrupted in
an isolated browser to keep the originating document visible; no real write
backend, auth service, staging or production is exercised. The browser clock
advances to the real ten-second bound. Hono a11y/Lighthouse gates do not cover Kit.

## Before and after

| Fixture | Before | After: all five states |
| --- | --- | --- |
| Hono event create, desktop | [1280×800](hono-event-new-1280-before.png) | [State sheet](hono-event-new-1280-after-states.png) |
| Hono event create, mobile | [390×844](hono-event-new-390-before.png) | [State sheet](hono-event-new-390-after-states.png) |
| Kit featured edit, desktop | [1280×800](kit-featured-edit-1280-before.png) | [State sheet](kit-featured-edit-1280-after-states.png) |
| Kit featured edit, mobile | [390×844](kit-featured-edit-390-before.png) | [State sheet](kit-featured-edit-390-after-states.png) |

## Visual findings

- The new status is readable on the existing light Hono and dark Kit canvases.
  It sits beside the save workflow, wraps within mobile content, leaves Save
  focused, and clears on pageshow. No material issue in the changed status.
- Empty status paragraphs add a small existing-paragraph-sized separation on
  some forms; no controls are hidden or moved outside the viewport width.
- Existing Kit dark-canvas help-text/fieldset contrast issues are visible in the
  baseline as well as the head. They are not corrected or masked by this change.
- These images are review evidence, not accepted visual-regression baselines.
  No screenshot comparison threshold, mask or baseline was changed.
