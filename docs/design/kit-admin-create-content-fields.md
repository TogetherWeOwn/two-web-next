# Kit new-event content fields

## Design contract

- **Audience and screen job:** moderators preparing a draft event, including keyboard and screen-reader users. Carry the same optional public access and joining details as the existing Hono create form.
- **Primary action:** Create draft. Native POST `/admin/events` remains Hono-owned and works without JavaScript. Publication is a separate existing action.
- **Real content:** Accessibility notes (1000 Unicode code points), organizer display name (500), public joining link (2048, existing HTTP(S) validation), and public joining instructions (5000). Blank values remain optional. Help warns against contact details, unverified claims and private/attendee-only links.
- **References:** [Hono field labels and help](../../src/admin/pages/event-form-fields.tsx), [existing Kit create layout](../../web/src/routes/admin/events/new/+page.svelte), and [shared validation targets](../../src/admin/form-errors.ts). Assumption: reuse established admin typography, spacing and field order; this is parity, not a new visual direction.
- **Layout:** keep the single-column form. Put accessibility notes after Description; put organizer and joining fields after Location, before Capacity. Labels sit above full-width controls; each hint follows its control and precedes its error. Textareas use four rows.
- **Typography and tokens:** inherit `AdminShell`, `.field`, `.hint`, `.error`, `.notice`, and `.actions`. No new CSS, tokens, framework or visual baselines.
- **Responsive behavior:** preserve the existing fluid admin panel at 1280×800 and 390×844. Long help and error text must wrap without horizontal overflow; all controls retain their visible labels and native keyboard order.
- **States:** fresh/empty, populated with multiline and escaped text, and retained values with four field errors. Summary links target the real field IDs; `aria-describedby` includes hint and conditional error. Existing text-limit and draft/departure islands enhance applicable controls without becoming submission requirements. Joining-link length and public-link policy remain server-owned; no new native truncation.
- **Non-goals:** edit forms, saved baselines, schema/persistence changes, publication requirements, private contact collection, route enablement, permission/audit/cache changes, or live rollout claims.

## Verification scope

The Hono and serializer controls in `test/admin-create-content-baseline.test.ts` were extracted in #2131. The Kit notes cases from #2136 now exercise all four fields in `test/kit-admin-create-public-details.test.ts`: control parity, retained/escaped values, Unicode and URL bounds, linked errors, progressive limits, draft protection and the real Hono 422. The composed Postgres cases preserve the original exact redirect, storage, audit, draft privacy, guest readback, populated/blank/whitespace/omitted values and denied writes. They use fixture-only publication and do not exercise publication/write-back.

Historical reference captures below were opened at both viewport sizes, using component SSR with synthetic content and the then-current light theme. The current built-Kit contrast fixture captures fresh, populated and linked-error states in the admin theme. Neither fixture is a deployed route or a live moderator submission. Kit GET stays disabled. Hono a11y, Lighthouse and public visual gates do not exercise this Kit page.

| State | Before desktop / mobile | After desktop / mobile |
| --- | --- | --- |
| Fresh | [1280](evidence/kit-admin-create/before-fresh-desktop.png) / [390](evidence/kit-admin-create/before-fresh-mobile.png) | [1280](evidence/kit-admin-create/after-fresh-desktop.png) / [390](evidence/kit-admin-create/after-fresh-mobile.png) |
| Populated | [1280](evidence/kit-admin-create/before-populated-desktop.png) / [390](evidence/kit-admin-create/before-populated-mobile.png) | [1280](evidence/kit-admin-create/after-populated-desktop.png) / [390](evidence/kit-admin-create/after-populated-mobile.png) |
| Field errors | [1280](evidence/kit-admin-create/before-field-error-desktop.png) / [390](evidence/kit-admin-create/before-field-error-mobile.png) | [1280](evidence/kit-admin-create/after-field-error-desktop.png) / [390](evidence/kit-admin-create/after-field-error-mobile.png) |
