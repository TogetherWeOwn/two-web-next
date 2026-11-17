<script lang="ts">
  import TimeBlock from "../../web/src/lib/TimeBlock.svelte";

  let { data } = $props();
</script>

<TimeBlock {...data} />
