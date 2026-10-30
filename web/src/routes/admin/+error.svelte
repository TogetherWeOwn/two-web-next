<script lang="ts">
import { page } from "$app/state";
import AdminShell from "#lib/AdminShell.svelte";
import { adminReadRetryHref } from "#lib/admin-read-retry.ts";

// Admin group error boundary for GET /admin, /admin/events[/:key],
// /admin/featured[/:id] and /admin/activity-log: those loads throw the branded
// 404 (missing row) and 503 (database down) with private, no-store, so they
// render here inside the moderator chrome instead of the public root
// boundary — the join-attempts pattern generalized to the whole admin group.
// (Join-attempts keeps its own more-specific boundary.) The failure itself is
// never echoed — message and trace stay in the logs, never in a moderator's
// browser — and the page reads no session and no database merely to offer
// recovery. Back links are plain anchors, exactly like the Hono pages;
// csr=false comes from the admin group layout, so no client script ships.
// Guard refusals never reach this boundary: SvelteKit renders a layout
// failure above the layout, so the root boundary keeps serving those
// unchanged. noindex travels via AdminShell. The root layout forwards the
// dispatch's validated request id as page.data.requestId, rendered below in
// the shared support-reference block; without one the page stays blank-safe,
// exactly like the join-attempts boundary.
const routeId = $derived(page.route.id ?? "");
const eventFamily = $derived(routeId.startsWith("/admin/events/"));
const featuredFamily = $derived(routeId.startsWith("/admin/featured/"));
const missing = $derived(page.status === 404);
const outage = $derived(page.status === 503);
const retryHref = $derived(
  outage || page.status === 500 ? adminReadRetryHref(page.url, "admin") : null,
);
const eventMissing = $derived(missing && eventFamily);
const featuredMissing = $derived(missing && featuredFamily);
const reference = $derived(page.data?.requestId);
const title = $derived(
  eventMissing
    ? "Event not found"
    : featuredMissing
      ? "Featured content not found"
      : outage
        ? "Admin temporarily unavailable"
        : "Something went wrong",
);
</script>

<AdminShell {title}>
<section aria-labelledby="admin-error-heading">
  <p>
    {#if eventFamily}
      <a href="/admin/events">Back to events</a>
      {" · "}
    {:else if featuredFamily}
      <a href="/admin/featured">Back to featured</a>
      {" · "}
    {/if}
    <a href="/admin">Back to the dashboard</a>
  </p>
  {#if eventMissing}
    <h1 id="admin-error-heading">Event not found</h1>
    <p class="hint">There is no event with that key.</p>
  {:else if featuredMissing}
    <h1 id="admin-error-heading">Featured content not found</h1>
    <p class="hint">There is no featured item with that id. It may have been deleted.</p>
  {:else if outage}
    <h1 id="admin-error-heading">Admin temporarily unavailable</h1>
    <p class="hint">The admin panel is temporarily unavailable. Try again shortly.</p>
  {:else}
    <h1 id="admin-error-heading">Something went wrong</h1>
    <p class="hint">The request could not be completed. Try again shortly.</p>
  {/if}
  {#if reference}
    <!-- Hono SupportReference conventions (src/error-pages.tsx), the same
      block the join-attempts boundary renders: the moderator guide promises
      a support reference on admin pages, and this boundary is one. -->
    <p class="support-reference">
      Support reference: <code data-testid="error-support-reference">{reference}</code>
    </p>
  {/if}
  {#if retryHref}
    <p><a href={retryHref} style="outline-color: var(--color-lobby-focus)">Retry loading</a></p>
  {/if}
</section>
</AdminShell>
