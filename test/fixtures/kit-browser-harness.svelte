<script>
  let count = $state(0);
</script>

<svelte:head><title>Café fixture</title></svelte:head>

<button onclick={() => count++}>Count: {count}</button>

<style>
  button { color: rgb(12, 34, 56); }
</style>
