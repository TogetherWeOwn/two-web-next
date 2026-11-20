<script lang="ts">
import TimeBlock from "../../web/src/lib/TimeBlock.svelte";

let { data: _data } = $props();
</script>

<TimeBlock {..._data} />
