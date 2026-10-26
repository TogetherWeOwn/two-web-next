# Dashboard draft-review signal: visual evidence

The `/admin` dashboard gains a **Draft review** section between the resource
cards and the Join funnel. It is an existence signal, not a count: `Drafts
await review.` when a draft exists, `No drafts await review.` only after a
successful empty read, and no section at all when the read degrades. Both
states link the draft-filtered inventory (`/admin/events?status=draft`) and
the create-draft form (`/admin/events/new`).

## Shots

Real renderers, local fixture rows (moderator actor, funnel
`added 7 / rate_limited 2`, one zero-search row): Hono `AdminDashboard`
through Hono's JSX runtime, Kit `+page.svelte` through Svelte's server
compiler, both with the shared `/styles.css` author sheet. Full document at
desktop (1280x800) and mobile (390x844) viewports. All twelve images were
opened and inspected.

| State | Hono desktop | Hono mobile | Kit desktop | Kit mobile |
| --- | --- | --- | --- | --- |
| Present | [hono-present-desktop](hono-present-desktop.png) | [hono-present-mobile](hono-present-mobile.png) | [kit-present-desktop](kit-present-desktop.png) | [kit-present-mobile](kit-present-mobile.png) |
| Absent | [hono-absent-desktop](hono-absent-desktop.png) | [hono-absent-mobile](hono-absent-mobile.png) | [kit-absent-desktop](kit-absent-desktop.png) | [kit-absent-mobile](kit-absent-mobile.png) |
| Degraded | [hono-degraded-desktop](hono-degraded-desktop.png) | [hono-degraded-mobile](hono-degraded-mobile.png) | [kit-degraded-desktop](kit-degraded-desktop.png) | [kit-degraded-mobile](kit-degraded-mobile.png) |

The change is additive (one optional prop plus one conditional block), so
the degraded shots are also the before-state pixels: rendering without the
new prop produces the pre-change markup byte-for-byte for the same inputs.

## What was checked in each image

- The signal heading, status sentence and both links render in present and
  absent states; the degraded state shows no signal and no zero claim.
- Cards, Join funnel and Top searches with no results are unchanged in all
  states; document width stays within the viewport at both widths.
- Kit matches Hono section for section at both widths.
