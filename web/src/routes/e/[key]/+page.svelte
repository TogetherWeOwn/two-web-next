<script lang="ts">
import EventDetail from "#lib/EventDetail.svelte";
import type { PageProps } from "./$types";

// One Svelte detail view for the live /e/:key reads: the load maps every
// non-ok outcome onto redirect()/error(), so only the ok model arrives here.
// No markup lives here.
let { data }: PageProps = $props();
</script>

<EventDetail model={data.model} restoredWrite={data.restoredWrite} />
