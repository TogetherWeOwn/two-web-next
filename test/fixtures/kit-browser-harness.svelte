<script>
let _count = $state(0);
</script>

<svelte:head><title>Café fixture</title></svelte:head>

<button onclick={() => _count++}>Count: {_count}</button>

<style>
  button { color: rgb(12, 34, 56); }
</style>
