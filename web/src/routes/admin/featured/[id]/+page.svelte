<script lang="ts">
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
// value on render, like the Hono JSX shell). The preview panel mirrors the
// Hono panel exactly: a Saved content preview with the saved headline, body,
// judged link and image in the public card presentation for every saved
// status (through the shared stored-link judge and the shared
// featuredImageSrc() policy with the homepage alt fallback), then a Homepage
// eligibility verdict with the shared status the load resolves — never a
// UI-local copy — the shared eligibility reason and the saved UTC window
// bounds. No JavaScript: plain POSTs
// and links, like the Hono panel. The edit form mounts the deferred
// dirty-draft/double-submit guard island as progressive markup (like
// join/+page.svelte): with csr=false the no-JS contract still holds, and a
// repeat submit cannot apply twice. The delete form stays a plain POST —
// destructive actions are never links — so crawlers and prefetchers cannot
// trigger them.
let { data }: PageProps = $props();
const island = '<script src="/islands/admin-event-editor.js" defer></' + "script>";
</script>

<AdminShell title={`Edit ${data.view.title}`}>
<section class="featured-form">
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
    <h3>Saved content preview</h3>
    <article class="card" data-testid="featured-item">
      <h3>{#if data.view.previewUrl}<a href={data.view.previewUrl}>{data.view.title}</a>{:else}{data.view.title}{/if}</h3>
      {#if data.view.values.body}<p>{data.view.values.body}</p>{/if}
      {#if data.view.imageSrc}<img
        class="featured-image"
        src={data.view.imageSrc}
        alt={data.view.imageAlt}
        width="640"
        height="360"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
      />{/if}
    </article>
    <h3>Homepage eligibility at this check time</h3>
    <p>
      Status: <span
        class={`featured-status featured-status-${data.view.status}`}
        data-status={data.view.status}
      >{data.view.status}</span>
    </p>
    <p>{data.view.eligibilityReason}</p>
    <p>
      Saved window (UTC): show from
      {#if data.view.startsAt}<time datetime={data.view.startsAt}>{data.view.startsAt}</time>{:else}{data.view.startsAtLabel}{/if},
      show until
      {#if data.view.endsAt}<time datetime={data.view.endsAt}>{data.view.endsAt}</time>{:else}{data.view.endsAtLabel}{/if}.
      {data.view.windowRules}
    </p>
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
  {@html '<p data-admin-save-status="" role="status" aria-live="polite" aria-atomic="true"></p>'}
  {@html data.view.deleteReviewHtml}
</section>
{@html island}
</AdminShell>
