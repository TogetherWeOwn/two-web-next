<script lang="ts">
import { page } from "$app/state";
import AdminShell from "#lib/AdminShell.svelte";
import type { Snippet } from "svelte";

// Admin route group chrome: one shell for the group. Each child load names
// its section title (page.data.sectionTitle); routes that predate the
// convention fall back to the dashboard title. page.data is the merged
// layout + page data, so this stays correct as child slices land.
let { children }: { children: Snippet } = $props();
const title = $derived(page.data.sectionTitle ?? "Dashboard");
</script>

<AdminShell title={title}>{@render children()}</AdminShell>
