<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { Snippet } from "svelte";

// Admin route group chrome: one shell for the group. Child
// slices parameterize the title when they land; the dashboard is the only
// child today.
let { children }: { children: Snippet } = $props();
</script>

<AdminShell title="Dashboard">{@render children()}</AdminShell>
