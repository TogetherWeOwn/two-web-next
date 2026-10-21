<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";

// Markup contract of FeaturedFormPage mode="new"
// (src/admin/pages/featured-form.tsx): the POST destination, every Hono
// field name, the control kinds, the hint copy, the save testid and the
// cancel destination are shared, so the existing admin E2E selectors still
// apply when this route owns traffic and the Hono POST /admin/featured
// validator keeps accepting this form unchanged during mixed mode.
// No JavaScript: a plain POST and a cancel link, like the Hono panel. The
// deferred dirty-draft/double-submit guard island is progressive markup
// (like join/+page.svelte): with csr=false the no-JS contract still holds.
// The editorial-limits island is the same shared progressive enhancement the
// Hono panel loads: static budget hints with JavaScript disabled, live
// trimmed-unit counts when it runs.
const limitsIsland =
  '<script type="module" src="/islands/admin-featured-editorial-limits.js"></' + "script>";
const island = '<script src="/islands/admin-event-editor.js" defer></' + "script>";
</script>

<AdminShell title="New featured slot">
<section class="featured-form">
  <h1>New featured slot</h1>
  <form method="post" action="/admin/featured" data-event-editor="">
    <!-- Native maxlength counts UTF-16 units and truncates supplementary
        characters early; the 255-code-point limits belong to the server
        validator so valid headlines and image descriptions survive. -->
    <div class="field">
      <label for="f-title">Headline</label>
      <input id="f-title" name="title" type="text" value="" data-featured-limit={255} data-featured-units="code-points" aria-describedby="f-title-hint" required />
      <p id="f-title-hint" class="hint">
        Up to 255 code points — the server trims whitespace, then counts.
      </p>
    </div>
    <div class="field">
      <label for="f-body">Body</label>
      <textarea id="f-body" name="body" rows={4} data-featured-limit={1000} data-featured-units="code-points" aria-describedby="f-body-hint"></textarea>
      <p id="f-body-hint" class="hint">
        Up to 1000 code points — the server trims whitespace, then counts.
      </p>
    </div>
    <div class="field">
      <label for="f-url">Link (full http(s) URL, or empty)</label>
      <input id="f-url" name="url" type="url" value="" data-featured-limit={255} data-featured-units="utf16" aria-describedby="f-url-hint" />
      <p id="f-url-hint" class="hint">
        Up to 255 UTF-16 units — the server trims whitespace, then counts.
      </p>
    </div>
    <div class="field">
      <label for="f-image-url">Image URL</label>
      <input id="f-image-url" name="image_url" type="url" value="" data-featured-limit={255} data-featured-units="utf16" aria-describedby="f-image-url-hint" />
      <p id="f-image-url-hint" class="hint">
        HTTPS URL on cdn.discordapp.com or a configured approved public host. Other image
        hosts are blocked by the site's security policy. Up to 255 UTF-16 units — the
        server trims whitespace, then counts.
      </p>
    </div>
    <div class="field">
      <label for="f-image-alt">Image description</label>
      <input id="f-image-alt" name="image_alt" type="text" value="" data-featured-limit={255} data-featured-units="code-points" aria-describedby="f-image-alt-hint" />
      <p id="f-image-alt-hint" class="hint">
        Required when an image URL is set — one plain sentence for screen-reader visitors.
        Up to 255 code points — the server trims whitespace, then counts.
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
        value="0"
      />
    </div>
    <div class="field">
      <label for="f-starts-at">Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)</label>
      <input id="f-starts-at" name="starts_at" type="text" value="" />
    </div>
    <div class="field">
      <label for="f-ends-at">Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)</label>
      <input id="f-ends-at" name="ends_at" type="text" value="" />
    </div>
    <div class="actions">
      <button type="submit" class="btn" data-testid="save-featured">Create</button>
      <a href="/admin/featured">Cancel</a>
    </div>
  </form>
</section>
{@html limitsIsland}
{@html island}
</AdminShell>
