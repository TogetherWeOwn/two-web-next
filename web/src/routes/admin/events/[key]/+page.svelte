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
// Hono-owned too. The pause review and read-only roster arrive as escaped
// server HTML via load data, using the same renderers as Hono. Injecting them
// via {@html} avoids duplicating their markup in the Kit bundles. Native GET
// roster controls need no client handlers; the parity test fails on drift.
let { data }: PageProps = $props();
const view = $derived(data.view);
const values = $derived(view.values ?? {});
const errors = $derived(view.errors ?? {});
const hasErrors = $derived(view.hasErrors ?? Object.keys(errors).length > 0);
const val = (name: string) => values[name] ?? "";
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const textLimitsIsland =
  '<script type="module" src="/islands/admin-event-text-limits.js"></' + "script>";
const editorIsland =
  '<script src="/islands/admin-save-baseline.js" defer></' +
  "script>" +
  '<script src="/islands/admin-event-editor.js" defer></' +
  "script>";
</script>

<AdminShell title={`Edit ${view.title}`}>
<section>
  <h1>Edit {view.title}</h1>
  {#if view.savedNoticeHtml}{@html view.savedNoticeHtml}{/if}
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
    <input type="hidden" name="saved_baseline" value={val("saved_baseline")} />
    {@html view.fieldsHtml}
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
        <a class="btn" href={`/e/${encodeURIComponent(view.key)}?review=1`} data-testid="review-event">Review before publishing</a>
        <form method="post" action={`/admin/events/${view.key}/publish`}>
          <button type="submit" class="btn" data-testid="publish-event">Publish</button>
        </form>
      {/if}
      {#if view.showCancel}
        <form method="post" action={`/admin/events/${view.key}/cancel`}>
          <button
            type="submit"
            class="link"
            data-testid="cancel-event"
            aria-label={`Cancel event ${view.title}`}>Cancel event</button
          >
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
          <button
            type="submit"
            class="link"
            data-testid="rsvp-reopen"
            aria-label={`Reopen RSVPs for ${view.title}`}>Reopen RSVPs</button
          >
        </form>
      {/if}
    </div>
  </section>
  {@html view.rosterHtml}
  {@html textLimitsIsland}
  {@html editorIsland}
</section>
</AdminShell>
