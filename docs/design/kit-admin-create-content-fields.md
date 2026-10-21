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

The independently authored `test/kit-admin-create-content-fields-acceptance.test.ts` compiles the real component, serializes its emitted controls into the real Hono 422 path, and pins optionality, hostile text, Unicode boundaries, error associations, progressive limits, draft behavior, recurrence, timezone and refusal-before-effects. It is consumed unchanged.

Capture and open fresh, populated and field-error states at both viewport widths before and after implementation, with application JavaScript disabled. A fixture component capture is not an authenticated deployed-route journey. The Kit GET remains disabled. Existing Hono a11y, Lighthouse and public visual gates do not exercise this Kit page; report their results separately and do not relax thresholds or accept unrelated baseline changes.
