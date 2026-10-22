# RSVP recovery FAQ visual evidence

Local-fixture captures of the real Hono FAQ route and compiled Svelte FAQ page,
using their existing leaf CSS and public assets. Each image was opened for
visual review. Separate Hono and Kit captures were byte-identical at both
widths; the shared copies below avoid storing duplicates.

| Viewport | Before | After: answers | After: promotion and recovery link |
| --- | --- | --- | --- |
| Desktop, 1280×800 | [Before](before-desktop-top.png) | [After top](after-desktop-top.png) | [After bottom](after-desktop-bottom.png) |
| Mobile, 390×844 | [Before](before-mobile-top.png) | [After top](after-mobile-top.png) | [After bottom](after-mobile-bottom.png) |

## Contract and findings

Audience: members checking their own answer and moderators helping with a
bounded next step. The primary action is to check the current event, not
resubmit. Reuse the existing Events section, question cards, section anchors,
leaf typography/tokens and native link treatment. No new visual direction,
CSS, framework, browser control or retry behavior is introduced.

References are the existing Hono `src/screens/faq.tsx`, Kit
`web/src/routes/faq/+page.svelte` and the
[join recovery guide](../../troubleshooting-join.md). Adapt their information
hierarchy and short diagnostic branches; do not duplicate sign-in recovery.
The added content distinguishes Going, Waitlisted, FIFO, saved/pending and
unknown outcomes, with one [focused recovery guide](../../rsvp-recovery.md).

The extra content increases vertical scrolling, as expected. Desktop retains
the section-label column; mobile stacks labels and questions. The answer,
promotion and recovery headings remain separate, and the underlined recovery
link wraps without horizontal overflow. Local axe scans found no violations
in either renderer at either width. No material hierarchy, spacing, clipping,
contrast or link-discovery finding remained in these captures.

## Method and limits

- Before: the accepted test-only integration tree, before content edits.
- After: the same Hono route and real Svelte page with the recovery content.
- A finite loopback harness served the application output and local public
  assets in isolated Chromium contexts. Off-origin browser requests were
  blocked. It used no database, live write, real member or credential.
- The adapter-generated Kit Worker was also built and served on loopback with
  no database or remote binding. `/faq` returned 200, `x-two-renderer: kit`,
  `public, max-age=3600`, no session cookie, and the same guide link. Its two
  after captures were byte-identical to the shared after-bottom images.
- Initial full-page attempts were rejected: the existing FAQ
  `content-visibility:auto` left offscreen sections unpainted. The published
  viewport captures instead scroll the real section into view; no CSS,
  screenshot mask or visual baseline was changed.
- These are local font-fallback renders, not the pinned CI runner's font
  baseline. Native visual regression remains the existing `browser-smoke`
  check; its current baseline set has no FAQ image. Hono accessibility and
  Lighthouse gates do not exercise the Kit route.

Functional proof is in the independent
[FAQ acceptance](../../../test/faq-rsvp-recovery-acceptance.test.ts),
[synthetic outcome matrix](../../../test/rsvp-recovery-outcome-matrix-acceptance.test.ts)
and [Kit parity suite](../../../test/kit-faq-parity.test.ts).
The matrix exercises current shipped RSVP fixtures, not a notification or
live database delivery claim. Source meanings and bounded recovery decisions
are documented in the [member guide](../../rsvp-recovery.md#source-references-and-synthetic-checks).
