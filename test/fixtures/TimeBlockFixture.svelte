<script lang="ts">
import TimeBlock from "../../web/src/lib/TimeBlock.svelte";

// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
let { data } = $props();
</script>

<TimeBlock {...data} />
