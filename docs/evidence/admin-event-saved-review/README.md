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

Final-head screenshots and complete GitHub Actions evidence are still pending.
No current visual, accessibility, performance or CI pass is claimed here.
The Hono gates do not exercise the Kit route; Kit needs its own screenshots.

The existing Actions `a11y` job captures the Hono review/notice routes. Its
`ci/event-time-from-now.test.mjs` fixture harness also captures both actual detail
renderers at both widths, ready/corrections/published/cancelled, under
`artifacts/a11y/saved-review/` in `a11y-evidence`. No baseline is accepted by these
captures. Publish-from-review, stale mutation and publish failure belong to the
second slice; this candidate is read-only.

At `e0b17c4a`, all 16 Hono/Kit state captures were downloaded and opened from
[Actions a11y-evidence](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42174903206/artifacts/13482957436).
The harness captures have a broken header logo; Kit uses a light surface and its
input outline is absent. These are observations, not visual acceptance. Six real
Hono route captures (save notice, corrections, cancelled; 360/1280) were also opened.
The audit failed two published-review attendee-count assertions before axe ran on
that state. Current-head rerun and independent UX/Security/QA acceptance remain.

The same run's Node 22 and coverage suites each finished with seven failures:
four draft redirect expectations, two expired CRUD fixtures, and Markdown's
invalid-date error pin (25,862 passed, 676 skipped in each suite). Corrections
retain the assertions, freeze the CRUD clock, and scope invalid-date fallback to
HTML. Corrected-head Actions remain pending. The failed check skipped later Kit
build/contrast gates; its contrast upload failed because no captures were produced.

At `a20737c6`, [corrected Actions](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42181673722)
failed lint on one import's formatting before types/tests. Browser setup omitted
Tailwind's required dependency callback: all 64 cases cancelled, no new captures.
The import and callback are corrected; verification remains pending. Scope,
docs-links, bundle-budget and Lighthouse passed; no overall green is claimed.

## Shared detail leaves — unexecuted preparation

The candidate reuses escaped Hono metadata, RSVP and roster presentation on Kit,
without changing member reads, native actions, focus targets, islands or styles.
The existing cancelled-review hidden time row remains Kit-only. One server clock
still decides RSVP and lineup availability. Direct fixture overrides rebuild the
same production HTML projection; the capture harness uses the real resolver.

No new captures, tests, build or byte measurements have run for this preparation.
Earlier screenshots and Actions results do not verify this broader candidate.
Independent real-route desktop/mobile UX, Security and QA acceptance, all four
unchanged Kit JS budgets and exact-final-head checks remain required.
