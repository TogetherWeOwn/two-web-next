<script lang="ts">
import AdminBreadcrumb from "#lib/AdminBreadcrumb.svelte";
import AdminShell from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";

// Markup contract of FeaturedFormPage mode="edit"
// (src/admin/pages/featured-form.tsx): the POST destinations, every Hono
// field name, the control kinds, the hint copy, the save/delete testids and
// the cancel destination are shared, so the existing admin E2E selectors still
// apply when this route owns traffic and the Hono POST /admin/featured/:id
// and POST /admin/featured/:id/delete validators keep accepting these forms
// unchanged during mixed mode. Values arrive from the load in the exact
// featuredValues() shape the Hono edit page renders (Svelte escapes every
// value on render, like the Hono JSX shell). The homepage preview shows the
// last saved status through the shared featuredStatus() the load resolves —
// never a UI-local copy — with the saved headline, body, judged link and
// image when the slot is currently visible (a simplified rendering of the
// Hono panel's full homepage item, through the shared stored-link judge and
// the shared featuredImageSrc() policy with the homepage alt fallback) and
// the same hidden-slot note the Hono panel renders when it is not. No
// JavaScript: plain POSTs
// and links, like the Hono panel. The edit form mounts the deferred
// dirty-draft/double-submit guard island as progressive markup (like
// join/+page.svelte): with csr=false the no-JS contract still holds, and a
// repeat submit cannot apply twice. The delete form stays a plain POST —
// destructive actions are never links — so crawlers and prefetchers cannot
// trigger them.
let { data }: PageProps = $props();
const island = '<script src="/islands/admin-event-editor.js" defer></' + "script>";
</script>

<AdminShell title={`Edit ${data.view.title}`} section="/admin/featured">
<section class="featured-form">
  <AdminBreadcrumb section="/admin/featured" />
  <h1>Edit {data.view.title}</h1>
  <section
    class="featured-preview"
    aria-labelledby="featured-preview-heading"
    data-testid="featured-preview"
  >
    <h2 id="featured-preview-heading">Homepage preview</h2>
    <p>
      Last saved content, checked at
      <time datetime={data.view.checkedAt}>{data.view.checkedAt}</time> (UTC). Save changes to
      refresh this preview.
    </p>
    <p>
      Status: <span
        class={`featured-status featured-status-${data.view.status}`}
        data-status={data.view.status}
      >{data.view.status}</span>
    </p>
    {#if data.view.visible}
      <p><strong>{data.view.title}</strong></p>
      {#if data.view.values.body}<p>{data.view.values.body}</p>{/if}
      {#if data.view.previewUrl}<p><a href={data.view.previewUrl}>Link</a></p>{/if}
      {#if data.view.imageSrc}<p><img
        src={data.view.imageSrc}
        alt={data.view.imageAlt}
        referrerpolicy="no-referrer"
      /></p>{/if}
    {:else}
      <p data-testid="featured-preview-hidden">
        This slot is not currently visible on the homepage.
      </p>
    {/if}
  </section>
  <form method="post" action={`/admin/featured/${data.view.id}`} data-event-editor="">
    <!-- Native maxlength counts UTF-16 units and truncates supplementary
        characters early; the 255-code-point limits belong to the server
        validator so valid headlines and image descriptions survive. -->
    <div class="field">
      <label for="f-title">Headline</label>
      <input id="f-title" name="title" type="text" value={data.view.values.title} required />
    </div>
    <div class="field">
      <label for="f-body">Body</label>
      <textarea id="f-body" name="body" rows={4}>{data.view.values.body}</textarea>
    </div>
    <div class="field">
      <label for="f-url">Link (full http(s) URL, or empty)</label>
      <input id="f-url" name="url" type="url" value={data.view.values.url} aria-describedby="f-url-hint" />
      <p id="f-url-hint" class="hint">
        No credentials, backslashes, whitespace or control characters.
      </p>
    </div>
    <div class="field">
      <label for="f-image-url">Image URL</label>
      <input id="f-image-url" name="image_url" type="url" value={data.view.values.image_url} aria-describedby="f-image-url-hint" />
      <p id="f-image-url-hint" class="hint">
        HTTPS URL on cdn.discordapp.com or a configured approved public host. Other image
        hosts are blocked by the site's security policy.
      </p>
    </div>
    <div class="field">
      <label for="f-image-alt">Image description</label>
      <input id="f-image-alt" name="image_alt" type="text" value={data.view.values.image_alt} aria-describedby="f-image-alt-hint" />
      <p id="f-image-alt-hint" class="hint">
        Required when an image URL is set — one plain sentence for screen-reader visitors.
      </p>
    </div>
    <div class="field">
      <label for="f-is-published">Published</label>
      <input id="f-is-published" name="is_published" type="checkbox" checked={data.view.values.is_published === "on"} />
    </div>
    <div class="field">
      <label for="f-position">Position (lower appears first)</label>
      <input
        id="f-position"
        name="position"
        type="text"
        inputmode="numeric"
        value={data.view.values.position}
      />
    </div>
    <div class="field">
      <label for="f-starts-at">Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)</label>
      <input id="f-starts-at" name="starts_at" type="text" value={data.view.values.starts_at} />
    </div>
    <div class="field">
      <label for="f-ends-at">Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)</label>
      <input id="f-ends-at" name="ends_at" type="text" value={data.view.values.ends_at} />
    </div>
    <div class="actions">
      <button type="submit" class="btn" data-testid="save-featured">Save</button>
      <a href="/admin/featured">Cancel</a>
    </div>
  </form>
  <form method="post" action={`/admin/featured/${data.view.id}/delete`}>
    <div class="actions">
      <button type="submit" class="link" data-testid="delete-featured">
        Delete this slot
      </button>
    </div>
  </form>
</section>
{@html island}
</AdminShell>
