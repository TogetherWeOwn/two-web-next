<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";

// Markup contract of FeaturedFormPage mode="new"
// (src/admin/pages/featured-form.tsx): the POST destination, every Hono
// field name, the control kinds, the hint copy, the save testid and the
// cancel destination are shared, so the existing admin E2E selectors still
// apply when this route owns traffic and the Hono POST /admin/featured
// validator keeps accepting this form unchanged during mixed mode. Values
// arrive from the load: empty for an ordinary visit, or editorial content
// copied by a reuse link into this unsaved form (Svelte escapes every
// value on render, like the Hono JSX shell). No JavaScript: a plain POST
// and a cancel link, like the Hono panel. The deferred
// dirty-draft/double-submit guard island is progressive markup
// (like join/+page.svelte): with csr=false the no-JS contract still holds.
let { data }: PageProps = $props();
// An ordinary visit keeps the empty load model; the form owns its defaults.
const values = $derived(
  data.values ?? {
    title: "",
    body: "",
    url: "",
    image_url: "",
    image_alt: "",
    position: "0",
    starts_at: "",
    ends_at: "",
  },
);
const island = '<script src="/islands/admin-event-editor.js" defer></' + "script>";
</script>

<!-- csr=false still emits a client route node. Keep the editor server-only;
     the external dirty-draft island remains the only progressive enhancement.
     Direct SSR compilation without Vite's environment still renders the form. -->
{#if import.meta.env?.SSR !== false}
<AdminShell title="New featured slot">
<section class="featured-form">
  <h1>New featured slot</h1>
  {#if data.notice}<p>
      {data.notice === "prefill"
        ? "Unsaved new slot: content copied from a saved slot, original unchanged. Published, window and position use new-slot defaults; nothing saves until Create."
        : "Could not reuse that saved slot. Nothing was copied or saved."}
      <a href="/admin/featured/new">Start with an empty new slot</a>
    </p>{/if}
  <form method="post" action="/admin/featured" data-event-editor="">
    <!-- Native maxlength counts UTF-16 units and truncates supplementary
        characters early; the 255-code-point limits belong to the server
        validator so valid headlines and image descriptions survive. -->
    <div class="field">
      <label for="f-title">Headline</label>
      <input id="f-title" name="title" type="text" value={values.title} required />
    </div>
    <div class="field">
      <label for="f-body">Body</label>
      <textarea id="f-body" name="body" rows={4}>{values.body}</textarea>
    </div>
    <div class="field">
      <label for="f-url">Link (full http(s) URL, or empty)</label>
      <input id="f-url" name="url" type="url" value={values.url} aria-describedby="f-url-hint" />
      <p id="f-url-hint" class="hint">
        No credentials, backslashes, whitespace or control characters.
      </p>
    </div>
    <div class="field">
      <label for="f-image-url">Image URL</label>
      <input id="f-image-url" name="image_url" type="url" value={values.image_url} aria-describedby="f-image-url-hint" />
      <p id="f-image-url-hint" class="hint">
        HTTPS URL on cdn.discordapp.com or a configured approved public host. Other image
        hosts are blocked by the site's security policy.
      </p>
    </div>
    <div class="field">
      <label for="f-image-alt">Image description</label>
      <input id="f-image-alt" name="image_alt" type="text" value={values.image_alt} aria-describedby="f-image-alt-hint" />
      <p id="f-image-alt-hint" class="hint">
        Required when an image URL is set — one plain sentence for screen-reader visitors.
      </p>
    </div>
    <div class="field">
      <label for="f-is-published">Published</label>
      <input id="f-is-published" name="is_published" type="checkbox" />
    </div>
    <div class="field">
      <label for="f-position">Position (lower appears first)</label>
      <input
        id="f-position"
        name="position"
        type="text"
        inputmode="numeric"
        value={values.position}
      />
    </div>
    <div class="field">
      <label for="f-starts-at">Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)</label>
      <input id="f-starts-at" name="starts_at" type="text" value={values.starts_at} />
    </div>
    <div class="field">
      <label for="f-ends-at">Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)</label>
      <input id="f-ends-at" name="ends_at" type="text" value={values.ends_at} />
    </div>
    <div class="actions">
      <button type="submit" class="btn" data-testid="save-featured">Create</button>
      <a href="/admin/featured">Cancel</a>
    </div>
  </form>
  {@html '<p data-admin-save-status="" role="status" aria-live="polite" aria-atomic="true"></p>'}
</section>
{@html island}
</AdminShell>
{/if}
