<script module lang="ts">
export const adminRouteIdContext = Symbol("admin route ID");

// Both admin error boundaries render this shell. Keep their retry-link
// helper here so they ship in the same chunk. Only GET pages owned by these
// boundaries are valid destinations. Unusable state falls back to fixed links.
export function adminReadRetryHref(
  url: unknown,
  boundary: "admin" | "join-attempts",
): string | null {
  try {
    if (!(url instanceof URL)) return null;
    const { pathname, search } = url;
    if (typeof pathname !== "string" || typeof search !== "string") return null;
    const readPath =
      boundary === "join-attempts"
        ? /^\/admin\/join-attempts(?:\/[1-9][0-9]*)?$/
        : /^\/admin(?:\/(?:events(?:\/[a-zA-Z0-9_-]+)?|featured(?:\/[1-9][0-9]*)?|activity-log|reconciliation(?:\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})?))?$/;
    if (
      !readPath.test(pathname) ||
      /\/(?:delete|destroy|logout|redispatch)(?:\/|$)/i.test(pathname)
    )
      return null;
    const href = pathname + search;
    if ((search !== "" && !search.startsWith("?")) || /[\\\u0000- \u007f#]/.test(href)) return null;
    // Preserve the encoded query (including duplicates), but never the fragment.
    return href;
  } catch {
    // Even a malformed URL/getter must leave the error boundary recoverable.
    return null;
  }
}
</script>

<script lang="ts">
import { getContext, type Snippet } from "svelte";

// Moderator chrome: the Kit twin of the Hono admin Shell
// (src/admin/pages/shell.tsx). Same brand, same labelled nav, same skip
// link and footer, same /styles.css author sheet — every admin screen under
// web/src/routes/admin/ renders inside this, so the guard and the chrome
// each exist exactly once. Destinations stay on the existing /admin/*
// paths, which Hono serves until each child slice migrates, so every link
// works during mixed mode. Admin is never indexed.
//
let {
  title,
  restoredWrite = false,
  children,
}: { title: string; restoredWrite?: boolean; children: Snippet } = $props();

const routeId = getContext<string | null | undefined>(adminRouteIdContext);
</script>

<svelte:head>
  <title>{title} — TWO admin</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/admin-rsvp-review.css" />
  <script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"></script>
</svelte:head>

<div class="kit-admin">
<a class="skip-link" href="#main">Skip to content</a>
<header class="bar">
  <a class="brand" href="/admin">TWO admin</a>
  <nav aria-label="Administration">
    <a href="/admin/events" aria-current={routeId === "/admin/events" ? "page" : undefined}>Events</a>
    {" · "}
    <a href="/admin/featured" aria-current={routeId === "/admin/featured" ? "page" : undefined}>Featured</a>
    {" · "}
    <a href="/admin/join-attempts" aria-current={routeId === "/admin/join-attempts" ? "page" : undefined}>Join attempts</a>
    {" · "}
    <a href="/admin/activity-log" aria-current={routeId === "/admin/activity-log" ? "page" : undefined}>Activity log</a>
    {" · "}
    <a href="/">Site</a>
  </nav>
</header>
<main id="main" tabindex="-1">{#if restoredWrite}<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>{/if}{@render children()}</main>
<footer>Together We Own · moderators only</footer>
</div>
