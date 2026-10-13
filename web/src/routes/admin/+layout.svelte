<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { LayoutProps } from "./$types";

// Admin route group chrome: one shell for the group. The document title
// arrives from the layout load (adminSectionTitle, src/admin/kit-guard.ts),
// one title per section, so slices never duplicate the head.
let { data, children }: LayoutProps = $props();
</script>

<AdminShell title={data.title}>{@render children()}</AdminShell>
