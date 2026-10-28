<script module lang="ts">
// The field groups share one emitter rather than duplicating input/error
// branches in both generated bundles. Metadata keeps the Hono field order,
// exact limits and safety copy; executed SSR tests pin each carried value.
type EventField = {
  name: string;
  id: string;
  label: string;
  textarea?: boolean;
  type?: "url";
  limit?: number;
  required?: boolean;
  hint?: string;
  inputmode?: "numeric";
};
const openingFields: EventField[] = [
  { name: "title", id: "f-title", label: "Title", limit: 100, required: true },
  { name: "game", id: "f-game", label: "Game", limit: 100 },
  { name: "description", id: "f-description", label: "Description", textarea: true, limit: 1000 },
];
const accessibilityFields: EventField[] = [
  {
    name: "accessibility_notes",
    id: "f-accessibility-notes",
    label: "Accessibility notes",
    textarea: true,
    limit: 1000,
    hint: "Optional; include only confirmed details, not personal contact information.",
  },
];
const joiningFields: EventField[] = [
  {
    name: "organizer_name",
    id: "f-organizer-name",
    label: "Organizer display name (optional)",
    limit: 500,
    hint: "Use a name the organizer has agreed to show publicly. Do not enter contact details.",
  },
  {
    name: "join_url",
    id: "f-join-url",
    label: "Public joining link (optional)",
    type: "url",
    hint: "HTTPS or HTTP link visible to everyone. Never use attendee-only or private links.",
  },
  {
    name: "join_instructions",
    id: "f-join-instructions",
    label: "Public joining instructions (optional)",
    textarea: true,
    limit: 5000,
    hint: "Share only verified details that are safe for anyone to see. Do not enter contact details.",
  },
];
const scheduleFields: EventField[] = [
  {
    name: "starts_at",
    id: "f-starts-at",
    label: "Starts (local wall time, YYYY-MM-DD HH:mm)",
    required: true,
  },
  {
    name: "ends_at",
    id: "f-ends-at",
    label: "Ends (local wall time, YYYY-MM-DD HH:mm)",
    required: true,
  },
  {
    name: "timezone",
    id: "f-timezone",
    label: "Timezone",
    hint: "The IANA zone the wall time above is typed in. Storage is UTC.",
  },
  { name: "location", id: "f-location", label: "Location", limit: 255 },
];
const capacityFields: EventField[] = [
  {
    name: "capacity",
    id: "f-capacity",
    label: "Capacity (empty = unlimited)",
    inputmode: "numeric",
  },
];
</script>

<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import { eventValidationSummary } from "../../../../../../src/admin/form-errors";
import type { PageProps } from "./$types";

// Markup contract of EventFormPage mode="edit"
// (src/admin/pages/event-form-page.tsx + event-form-fields.tsx,
// event-form-status.tsx, event-form-roster.tsx): the validation notice,
// field ids/names, edit-only series note, save/cancel actions, status
// buttons, roster search/sort/table/paging and the two progressive islands
// are shared, so the existing admin edit E2E selectors still apply when this
// route owns traffic. Values and field errors arrive from the load in the
// Hono eventValues shape (retained input, per-field messages, empty on a
// fresh GET). No island and no event handlers of its own: the edit, status
// and status-change forms post to the Hono-owned POST /admin/events/:key,
// .../publish, .../cancel, .../duplicate, .../rsvp-pause and .../rsvp-reopen
// endpoints, so
// the page works with JavaScript disabled, exactly like the Hono panel. The
// text-limit and editor islands enhance it when JavaScript runs. There is
// deliberately no removal affordance anywhere on this resource, and this
// port adds none: the guarded /admin/events/:key/edit legacy redirect stays
// Hono-owned too. The pause review arrives as pre-rendered server HTML via
// load data (the same src/admin/rsvp-review.ts renderer Hono mirrors),
// injected via {@html}: inlined literals or a shared component would breach
// the client gzip and file-count ceilings. The parity test fails on drift.
let { data }: PageProps = $props();
const view = $derived(data.view);
const values = $derived(view.values ?? {});
const errors = $derived(view.errors ?? {});
const hasErrors = $derived(view.hasErrors ?? Object.keys(errors).length > 0);
const val = (name: string) => values[name] ?? "";
const roster = $derived(view.roster);
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const editorIslands =
  '<script type="module" src="/islands/admin-event-text-limits.js"></' +
  'script><script src="/islands/admin-event-editor.js" defer></' + "script>";
</script>

{#snippet eventFields(fields: EventField[])}
  {#each fields as field (field.name)}
    {@const error = errors[field.name]}
    {@const describedBy = [field.hint ? `${field.id}-hint` : "", error ? `${field.id}-error` : ""].filter(Boolean).join(" ") || undefined}
    <div class="field">
      <label for={field.id}>{field.label}</label>
      {#if field.textarea}
        <textarea
          id={field.id}
          name={field.name}
          rows="4"
          data-event-text-limit={field.limit}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        >{val(field.name)}</textarea>
      {:else}
        <input
          id={field.id}
          name={field.name}
          type={field.type ?? "text"}
          inputmode={field.inputmode}
          value={field.name === "timezone" ? val(field.name) || "Europe/London" : val(field.name)}
          data-event-text-limit={field.limit}
          required={field.required}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/if}
      {#if field.hint}
        <p id={`${field.id}-hint`} class="hint">{field.hint}</p>
      {/if}
      {#if error}
        <p id={`${field.id}-error`} class="error" role="alert" data-testid={`error-${field.name}`}>{error}</p>
      {/if}
    </div>
  {/each}
{/snippet}

<AdminShell title={`Edit ${view.title}`}>
<section>
  <h1>Edit {view.title}</h1>
  {#if hasErrors}
    <div class="notice" role="alert" tabindex="-1" data-testid="form-errors" data-admin-validation-summary="">
      <p>Check the highlighted fields and try again.</p>
      <ul>
        {#each eventValidationSummary(errors, "edit") as entry (entry.key)}
          <li>
            {#if entry.target}
              <a href={`#${entry.target}`}>{entry.label}: {entry.message}</a>
            {:else}
              {entry.message}
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <form
    method="post"
    action={`/admin/events/${data.view.key}`}
    data-event-editor=""
    data-event-draft={hasErrors ? "" : undefined}
  >
    {@render eventFields(openingFields)}
    {@render eventFields(accessibilityFields)}
    {@render eventFields(scheduleFields)}
    {@render eventFields(joiningFields)}
    {@render eventFields(capacityFields)}
    {#if view.seriesNote}
      <p class="hint" data-testid="series-info">{view.seriesNote}</p>
    {/if}
    <div class="actions">
      <button type="submit" class="btn" data-testid="save-event">Save</button>
      <a href="/admin/events">Cancel</a>
    </div>
  </form>
  {@html '<p data-admin-save-status="" role="status" aria-live="polite" aria-atomic="true"></p>'}
  <section aria-label="Status">
    <h2>Status: {view.status}</h2>
    <div class="actions rsvp-actions">
      {#if view.showPublish}
        <form method="post" action={`/admin/events/${view.key}/publish`}>
          <button type="submit" class="btn" data-testid="publish-event">Publish</button>
        </form>
      {/if}
      {#if view.showCancel}
        <form method="post" action={`/admin/events/${view.key}/cancel`}>
          <button type="submit" class="link" data-testid="cancel-event">Cancel event</button>
        </form>
      {/if}
      {#if view.status === "draft" || view.status === "published" || view.status === "cancelled"}
        <form method="post" action={`/admin/events/${view.key}/duplicate`}>
          <button type="submit" class="link" data-testid="duplicate-event">Duplicate as draft</button>
        </form>
      {/if}
      {#if view.rsvpAction === "rsvp-pause"}
        {@html view.pauseReviewHtml ?? ""}
      {:else if view.rsvpAction === "rsvp-reopen"}
        <form method="post" action={`/admin/events/${view.key}/rsvp-reopen`}>
          <button type="submit" class="link" data-testid="rsvp-reopen">Reopen RSVPs</button>
        </form>
      {/if}
    </div>
  </section>
  <section id="rsvp-roster" aria-label="RSVP roster" data-testid="rsvp-roster">
    <h2>RSVPs ({roster.total})</h2>
    <p class="hint">Save event changes before searching or sorting the roster.</p>
    <p data-testid="roster-range">
      {roster.rangeText}
    </p>
    <form method="get" action={roster.searchAction} class="filters">
      <input type="hidden" name="roster_sort" value={roster.query.sort} />
      <input type="hidden" name="roster_order" value={roster.query.order} />
      <div class="field">
        <label for="roster-status">Answer status</label>
        <select id="roster-status" name="roster_status">
          {#each roster.statusOptions as o (o.value)}
            <option value={o.value} selected={o.selected}>{o.label}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="roster-q">Search members</label>
        <input id="roster-q" name="roster_q" type="search" value={roster.query.q} />
      </div>
      <div class="field">
        <button type="submit" class="btn">Search</button>
      </div>
    </form>
    <p id="roster-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
    <!-- Keyboard-scroll parity with the Hono panel (test/admin-table-scroll-parity.test.ts):
      the labelled roster region stays Tab-focusable so keyboard users can arrow-scroll
      the wide roster, per axe scrollable-region-focusable. The compiler cannot tell a
      labelled scroll region from a static div, hence the scoped ignore. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="admin-table-scroll"
      role="region"
      aria-label="RSVP roster list"
      aria-describedby="roster-scroll-hint"
      tabindex={0}
      data-testid="roster-table-scroll"
    >
      <table class="admin-table" data-testid="roster-table">
        <thead>
          <tr>
            <th scope="col">Member</th>
            {#each roster.sortHeaders as h (h.key)}
              <th scope="col" aria-sort={h.ariaSort}>
                <a href={h.url} aria-label={h.linkLabel}>{h.label}{h.marker}</a>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#if roster.entries.length === 0}
            <tr>
              <td colspan={3} data-testid="roster-empty">{roster.emptyText}</td>
            </tr>
          {:else}
            {#each roster.entries as r, i (`${r.answeredAt}-${i}`)}
              <tr>
                <td>{r.member}</td>
                <td>{r.status}</td>
                <td>{r.answeredAt}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if roster.firstUrl || roster.clearUrl}
      <p class="actions">
        {#if roster.firstUrl}<a href={roster.firstUrl}>First page of these responses</a>{/if}
        {#if roster.clearUrl}<a href={roster.clearUrl}>Clear roster filters</a>{/if}
      </p>
    {/if}
    <nav aria-label="RSVP roster pages" class="actions">
      {#if roster.hasPrev}
        <a rel="prev" href={roster.prevUrl}>Previous</a>
      {/if}
      <span>Page {roster.query.page}</span>
      {#if roster.hasNext}
        <a rel="next" href={roster.nextUrl}>Next</a>
      {/if}
    </nav>
  </section>
  {@html editorIslands}
</section>
</AdminShell>
