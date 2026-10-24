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
// Hono-owned too.
let { data }: PageProps = $props();
const view = $derived(data.view);
const values = $derived(view.values);
const errors = $derived(view.errors);
const hasErrors = $derived(view.hasErrors);
const val = (name: string) => values[name] ?? "";
const roster = $derived(view.roster);
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const editorIslands =
  '<script type="module" src="/islands/admin-event-text-limits.js"></' +
  'script><script src="/islands/admin-event-editor.js" defer></' +
  "script>";
</script>

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
    <!-- The Hono-owned update refuses a save without the current baseline. -->
    <input type="hidden" name="saved_baseline" value={view.baseline} />
    <div class="field">
      <label for="f-title">Title</label>
      <input
        id="f-title"
        name="title"
        type="text"
        value={val("title")}
        data-event-text-limit={100}
        required
        aria-invalid={errors.title ? "true" : undefined}
        aria-describedby={errors.title ? "f-title-error" : undefined}
      />
      {#if errors.title}
        <p id="f-title-error" class="error" role="alert" data-testid="error-title">{errors.title}</p>
      {/if}
    </div>
    <div class="field">
      <label for="f-game">Game</label>
      <input
        id="f-game"
        name="game"
        type="text"
        value={val("game")}
        data-event-text-limit={100}
        aria-invalid={errors.game ? "true" : undefined}
        aria-describedby={errors.game ? "f-game-error" : undefined}
      />
      {#if errors.game}
        <p id="f-game-error" class="error" role="alert" data-testid="error-game">{errors.game}</p>
      {/if}
    </div>
    <div class="field">
      <label for="f-description">Description</label>
      <textarea
        id="f-description"
        name="description"
        rows={4}
        data-event-text-limit={1000}
        aria-invalid={errors.description ? "true" : undefined}
        aria-describedby={errors.description ? "f-description-error" : undefined}
      >{val("description")}</textarea>
      {#if errors.description}
        <p id="f-description-error" class="error" role="alert" data-testid="error-description">
          {errors.description}
        </p>
      {/if}
    </div>
    <!-- Same escaped SSR field as Hono; keeps notes visible without a duplicate client template. -->
    {@html view.notesHtml}
    <div class="field">
      <label for="f-starts-at">Starts (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-starts-at"
        name="starts_at"
        type="text"
        value={val("starts_at")}
        required
        aria-invalid={errors.starts_at ? "true" : undefined}
        aria-describedby={errors.starts_at ? "f-starts-at-error" : undefined}
      />
      {#if errors.starts_at}
        <p id="f-starts-at-error" class="error" role="alert" data-testid="error-starts_at">
          {errors.starts_at}
        </p>
      {/if}
    </div>
    <div class="field">
      <label for="f-ends-at">Ends (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-ends-at"
        name="ends_at"
        type="text"
        value={val("ends_at")}
        required
        aria-invalid={errors.ends_at ? "true" : undefined}
        aria-describedby={errors.ends_at ? "f-ends-at-error" : undefined}
      />
      {#if errors.ends_at}
        <p id="f-ends-at-error" class="error" role="alert" data-testid="error-ends_at">
          {errors.ends_at}
        </p>
      {/if}
    </div>
    <div class="field">
      <label for="f-timezone">Timezone</label>
      <input
        id="f-timezone"
        name="timezone"
        type="text"
        value={val("timezone") || "Europe/London"}
        aria-invalid={errors.timezone ? "true" : undefined}
        aria-describedby={errors.timezone ? "f-timezone-hint f-timezone-error" : "f-timezone-hint"}
      />
      <p id="f-timezone-hint" class="hint">
        The IANA zone the wall time above is typed in. Storage is UTC.
      </p>
      {#if errors.timezone}
        <p id="f-timezone-error" class="error" role="alert" data-testid="error-timezone">
          {errors.timezone}
        </p>
      {/if}
    </div>
    <div class="field">
      <label for="f-location">Location</label>
      <input
        id="f-location"
        name="location"
        type="text"
        value={val("location")}
        data-event-text-limit={255}
        aria-invalid={errors.location ? "true" : undefined}
        aria-describedby={errors.location ? "f-location-error" : undefined}
      />
      {#if errors.location}
        <p id="f-location-error" class="error" role="alert" data-testid="error-location">
          {errors.location}
        </p>
      {/if}
    </div>
    <!-- Escaped server output from the same fields Hono renders; never caller-supplied HTML. -->
    {@html view.hostJoinFieldsHtml}
    <div class="field">
      <label for="f-capacity">Capacity (empty = unlimited)</label>
      <input
        id="f-capacity"
        name="capacity"
        type="text"
        inputmode="numeric"
        value={val("capacity")}
        aria-invalid={errors.capacity ? "true" : undefined}
        aria-describedby={errors.capacity ? "f-capacity-error" : undefined}
      />
      {#if errors.capacity}
        <p id="f-capacity-error" class="error" role="alert" data-testid="error-capacity">
          {errors.capacity}
        </p>
      {/if}
    </div>
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
    <div class="actions">
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
      {#if view.rsvpAction}
        <form method="post" action={`/admin/events/${view.key}/${view.rsvpAction}`}>
          <button type="submit" class="link" data-testid={view.rsvpAction}>
            {view.rsvpAction === "rsvp-pause" ? "Pause RSVPs" : "Reopen RSVPs"}
          </button>
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
