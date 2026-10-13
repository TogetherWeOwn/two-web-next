<script lang="ts">
import type { Snippet } from "svelte";

// Admin route group outlet: no chrome here. Each child slice wraps itself in
// the shared AdminShell with its own title (dashboard: "Dashboard",
// activity-log: "Activity log", events: "Events"), the Kit twin of the Hono
// Shell titles, so a new slice never inherits the wrong tab title during
// mixed mode.
let { children }: { children: Snippet } = $props();
</script>

{@render children()}
