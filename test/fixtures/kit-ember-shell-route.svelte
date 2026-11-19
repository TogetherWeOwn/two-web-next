<script lang="ts">
import { page } from "$app/state";
import EmberShell from "#lib/EmberShell.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
</script>

{#snippet accountChrome()}
  <a href="/profile">Your profile</a>
{/snippet}

<SiteMetadata title="Welcome" theme="home" />
<EmberShell
  activeNav={page.url.searchParams.get("state") ==="member" ? "events" : "home"}
  member={page.url.searchParams.get("state") ==="member"}
  hideAccount={page.url.searchParams.get("state") ==="hidden"}
  accountChrome={page.url.searchParams.get("state") ==="member" ? accountChrome : undefined}
>
  <h1>Welcome to Together We Own</h1>
  <p>Find your next game night with the community.</p>
</EmberShell>
