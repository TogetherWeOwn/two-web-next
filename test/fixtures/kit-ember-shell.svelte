<script lang="ts">
import EmberShell from "../../web/src/lib/EmberShell.svelte";

let {
  data,
}: {
  data: {
    activeNav?: "home" | "events" | "event" | "leaderboard";
    member?: boolean;
    loginReturnTo?: string | null;
    hideAccount?: boolean;
    customAccount?: boolean;
  };
} = $props();
</script>

{#snippet accountChrome()}
  <a href="/profile">Your profile</a>
{/snippet}

<EmberShell {...data} accountChrome={data.customAccount ? accountChrome : undefined}>
  <h1>Shell content</h1>
</EmberShell>
