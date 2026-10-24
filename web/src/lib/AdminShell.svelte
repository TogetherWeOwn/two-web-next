<script lang="ts">
import type { Snippet } from "svelte";

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
  section = null,
  exact = false,
  children,
}: {
  title: string;
  /** Section root href, e.g. "/admin/events"; null when no section applies. */
  section?: string | null;
  /** True only when the rendered page IS the section root, never for a descendant. */
  exact?: boolean;
  children: Snippet;
} = $props();

// Same vocabulary as the Hono Shell (src/admin/pages/shell.tsx): exact list
// routes are the current page, new/edit/detail descendants mark the ancestor
// as the current location, and Site is never current. Dashboard current state
// rides the brand link, so no extra nav item exists in either renderer.
const mark = (href: string): "page" | "location" | undefined =>
  section === href ? (exact ? "page" : "location") : undefined;
</script>

<svelte:head>
  <title>{title} — TWO admin</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="stylesheet" href="/styles.css" />
  <script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"></script>
</svelte:head>

<div class="kit-admin">
<a class="skip-link" href="#main">Skip to content</a>
<header class="bar">
  <a class="brand" href="/admin" aria-current={mark("/admin")}>TWO admin</a>
  <nav aria-label="Administration">
    <a href="/admin/events" aria-current={mark("/admin/events")}>Events</a>
    {" · "}
    <a href="/admin/featured" aria-current={mark("/admin/featured")}>Featured</a>
    {" · "}
    <a href="/admin/join-attempts" aria-current={mark("/admin/join-attempts")}>Join attempts</a>
    {" · "}
    <a href="/admin/activity-log" aria-current={mark("/admin/activity-log")}>Activity log</a>
    {" · "}
    <a href="/">Site</a>
  </nav>
</header>
<main id="main" tabindex="-1">{@render children()}</main>
<footer>Together We Own · moderators only</footer>
</div>
