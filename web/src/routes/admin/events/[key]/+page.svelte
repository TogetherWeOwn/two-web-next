<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
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
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const editorIslands =
  '<script type="module" src="/islands/admin-event-text-limits.js"></' +
  'script><script src="/islands/admin-event-editor.js" defer></' +
  "script>";
</script>

<AdminShell title={`Edit ${view.title}`}>
<section>
  <h1>Edit {view.title}</h1>
  <!-- Escaped application-generated markup from Hono's EventFormFields.
    Both editors display and submit exactly the content covered by the baseline. -->
  {@html view.formHtml}
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
  {@html view.rosterHtml}
  {@html editorIslands}
</section>
</AdminShell>
