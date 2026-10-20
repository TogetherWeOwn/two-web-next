# Event purpose design contract

- **Audience and job:** Members deciding whether and how to attend; moderators describe the activity, intended audience, and preparation in a dedicated optional field.
- **Primary action:** Keep the existing RSVP flow primary. Purpose clarifies the event without changing publication or RSVP policy.
- **Content:** Preserve Description as separate supporting detail. Example purpose: “A relaxed introduction for new Go players.”
- **References:** Follow the existing [moderator form](../../../src/admin/pages/event-form-fields.tsx), [Hono event detail](../../../src/events/pages-detail.tsx), and [Kit event detail](../../../web/src/lib/EventDetail.svelte). Keep the canonical Markdown detail alternate aligned with HTML.
- **Layout, typography, and tokens:** Reuse existing section headings, form labels, textarea styling, spacing, and colors. Put Purpose before Description on detail pages and next to Description in the moderator form.
- **Responsive behavior:** Retain the existing responsive content flow; add no grid, media query, framework, or client-side dependency.
- **Required states:** Omitted, blank, and legacy-null values omit the public section. Present values render escaped for guests and members. Create/edit forms retain values and associate length errors with the field. Enforce the existing event-description convention of 1000 Unicode code points, including native browser validation.
- **Non-goals:** No publication requirement, description rewrite, attendance metric, policy change, or purpose field on listings, feeds, API serializers, calendar exports, or unrelated surfaces.

## Verification status

This is an implementation checkpoint, not a completed visual or release sign-off. Hono detail rendering and moderator persistence are implemented. Kit and Markdown parity, acceptance-author fixture updates, final screenshot review, and full verification remain required before a ready pull request.
