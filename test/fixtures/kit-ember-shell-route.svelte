<script lang="ts">
import { page } from "$app/state";
import EmberShell from "#lib/EmberShell.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
</script>

{#snippet accountChrome()}
  <a class="menu-desktop-account" href="/profile">Your profile</a>
  <form action="/logout" method="post"><button data-testid="signout">Sign out</button></form>
{/snippet}

<SiteMetadata title="Welcome" theme="home" />
<EmberShell
  activeNav={page.url.searchParams.get("state") === "member" ? "event" : "home"}
  member={page.url.searchParams.get("state") === "member"}
  authenticated={page.url.searchParams.has("auth") ? page.url.searchParams.get("auth") === "1" : undefined}
  hideAccount={page.url.searchParams.get("state") === "hidden"}
  accountChrome={page.url.searchParams.get("auth") === "1" ? accountChrome : undefined}
>
  <h1>Welcome to Together We Own</h1>
  <p>Find your next game night with the community.</p>
</EmberShell>
