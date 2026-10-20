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

The optional purpose field is wired through moderator persistence, Hono and Kit event details, and the per-event Markdown alternate. The public Markdown collection, other event serializers, publication policy, and RSVP flow remain unchanged.

- Captured and visually opened local fixture screenshots for the admin create form (before at desktop/mobile, after at desktop), the shared edit form at mobile, edit-length errors at desktop/mobile, and published-purpose plus legacy-blank detail at desktop/mobile. The edit form shares the same field component as create.
- With the disposable test database, all 109 changed unit-test files passed together: 1,920 tests passed and 101 were skipped. The new purpose-export regression is included; after reverting a stale unrelated audit expectation to match the baseline, `test/featured-create-atomicity.test.ts` passed separately (3 tests).
- `npm run check --prefix web`, `npm run lint`, `npm run standards` (8 routes; 21 internal links), `npm run kit-parity:test` (67 tests), `npm run budget`, `npx wrangler deploy --dry-run --outdir dist`, and `npm run worker-budget` passed.
- `npm run check` passed lint, typecheck, E2E typecheck, config validation, and docs links, then Vitest reported 812 files passed, 4 skipped, and 7 failures: six in unchanged `test/workflow-migration-auth.test.ts` because the local managed Git fixture could not fetch its baseline, plus one stale `purpose: null` expectation in `test/featured-create-atomicity.test.ts`. The unrelated expectation was reverted to match the base and that file then passed 3/3; the full check was not rerun. Later check stages were not reached.
- Automated browser gates remain unverified locally: `npm run a11y` cannot launch Chromium because `libglib-2.0.so.0` is missing; `npm run lighthouse` and `npm run lighthouse:quality` report Chrome installation missing (0/24 quality reports collected). The E2E visual spec was not run because it writes/deletes seeded DB rows and this run has no fresh run-owned visual-test database. No thresholds or baselines were changed.
- Staging has not been checked because this branch is not deployed there. Hono gates do not exercise the Kit route; the opened desktop/mobile screenshots are the Kit visual evidence.
