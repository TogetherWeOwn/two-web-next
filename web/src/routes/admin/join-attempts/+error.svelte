<script lang="ts">
import { page } from "$app/state";
import AdminShell from "#lib/AdminShell.svelte";

// Route-level error page for GET /admin/join-attempts and
// GET /admin/join-attempts/:id: the list and detail loads throw the branded
// 404 (missing row) and 503 (database down) with private, no-store, so they
// render here inside the moderator chrome instead of the public root
// boundary. The failure itself is never echoed — message and trace stay in
// the logs, never in a moderator's browser — and the page reads no session
// and no database merely to offer recovery. Back links are plain anchors,
// exactly like the Hono pages; csr=false comes from the admin group layout,
// so no client script ships. Guard refusals never reach this boundary:
// SvelteKit renders a layout failure above the layout, so the root boundary
// keeps serving those unchanged. noindex travels via AdminShell. The root
// layout forwards the dispatch's validated request id as page.data.requestId,
// rendered below in the shared support-reference block; without one the page
// stays blank-safe, exactly like the public boundary.
const missing = $derived(page.status === 404);
const outage = $derived(page.status === 503);
const reference = $derived(page.data?.requestId);
const title = $derived(
  missing
    ? "Join attempt not found"
    : outage
      ? "Admin temporarily unavailable"
      : "Something went wrong",
);
</script>

<AdminShell {title}>
<section aria-labelledby="join-attempts-error-heading">
  <p>
    <a href="/admin/join-attempts">Back to join attempts</a>
    {" · "}
    <a href="/admin">Back to the dashboard</a>
  </p>
  {#if missing}
    <h1 id="join-attempts-error-heading">Join attempt not found</h1>
    <p class="hint">There is no join attempt with that id. It may have aged out of the retention window.</p>
  {:else if outage}
    <h1 id="join-attempts-error-heading">Admin temporarily unavailable</h1>
    <p class="hint">The admin panel is temporarily unavailable. Try again shortly.</p>
  {:else}
    <h1 id="join-attempts-error-heading">Something went wrong</h1>
    <p class="hint">The request could not be completed. Try again shortly.</p>
  {/if}
  {#if reference}
    <!-- Hono SupportReference conventions (src/error-pages.tsx), the same
      block the public boundary renders: the moderator guide promises a
      support reference on admin pages, and this boundary is one. -->
    <p class="support-reference">
      Support reference: <code data-testid="error-support-reference">{reference}</code>
    </p>
  {/if}
</section>
</AdminShell>
