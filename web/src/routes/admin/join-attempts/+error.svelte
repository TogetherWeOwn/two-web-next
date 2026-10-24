<script lang="ts">
import { page } from "$app/state";
import AdminShell from "#lib/AdminShell.svelte";
import { adminReadRetryHref } from "#lib/admin-read-retry.ts";

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
// keeps serving those unchanged. noindex travels via AdminShell.
const routeId = $derived(page.route.id ?? "");
// Same truthful-section rule as the admin group boundary: the list route is
// the exact page, a detail failure resolves to the ancestor.
const section = $derived.by(() => {
  if (routeId === "/admin/join-attempts") return { href: routeId, exact: true };
  if (routeId.startsWith("/admin/join-attempts/"))
    return { href: "/admin/join-attempts", exact: false };
  return null;
});
const missing = $derived(page.status === 404);
const outage = $derived(page.status === 503);
const retryHref = $derived(
  outage || page.status === 500 ? adminReadRetryHref(page.url, "join-attempts") : null,
);
const title = $derived(
  missing
    ? "Join attempt not found"
    : outage
      ? "Admin temporarily unavailable"
      : "Something went wrong",
);
</script>

<AdminShell {title} section={section?.href ?? null} exact={section?.exact ?? false}>
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
  {#if retryHref}
    <p><a href={retryHref} style="outline-color: var(--color-lobby-focus)">Retry loading</a></p>
  {/if}
</section>
</AdminShell>
