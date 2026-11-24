<script lang="ts">
import { page } from "$app/state";
import { adminRouteIdContext } from "#lib/AdminShell.svelte";
import { setContext, type Snippet } from "svelte";

// Admin route group outlet: no chrome here. Each child slice wraps itself in
// the shared AdminShell with its own title (dashboard: "Dashboard",
// featured: "Featured content", activity-log: "Activity log", events: "Events",
// join-attempts: "Join attempts"), the Kit twin of the Hono Shell titles,
// so a new slice never inherits the wrong tab title during mixed mode.
let { children }: { children: Snippet } = $props();

// This group is server-rendered only. The resolved route ID identifies the
// page independently of the URL spelling or the list's query parameters.
setContext(adminRouteIdContext, page.route.id);
</script>

{@render children()}
