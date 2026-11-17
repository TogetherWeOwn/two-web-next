<script lang="ts">
import { page } from "$app/state";
import EmberShell from "#lib/EmberShell.svelte";

let state = $derived(page.url.searchParams.get("state"));
</script>

{#snippet accountChrome()}
  <a href="/profile">Your profile</a>
{/snippet}

<EmberShell
  activeNav={state === "member" ? "events" : "home"}
  member={state === "member"}
  hideAccount={state === "hidden"}
  accountChrome={state === "member" ? accountChrome : undefined}
>
  <h1>Welcome to Together We Own</h1>
  <p>Find your next game night with the community.</p>
</EmberShell>
