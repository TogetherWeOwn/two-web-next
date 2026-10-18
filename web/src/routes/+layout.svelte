<script lang="ts">
import type { Snippet } from "svelte";
import "../app.css";

// Shared Kit layout: pulls the Tailwind v4 pipeline and the single Open
// Lobby token file (src/app.css) into every Kit page. Per-page chrome
// (header, footer, metadata, skip link, active nav) stays in Shell.svelte so
// the archive parity harness can render pages directly.
let { children }: { children: Snippet } = $props();
</script>

{@render children()}
