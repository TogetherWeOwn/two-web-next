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
let { title, children }: { title: string; children: Snippet } = $props();
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
    <a href="/admin/events">Events</a>
    {" · "}
    <a href="/admin/featured">Featured</a>
    {" · "}
    <a href="/admin/join-attempts">Join attempts</a>
    {" · "}
    <a href="/admin/activity-log">Activity log</a>
    {" · "}
    <a href="/">Site</a>
  </nav>
</header>
<main id="main" tabindex="-1">{@render children()}</main>
<footer>Together We Own · moderators only</footer>
</div>
