<script lang="ts">
import ProfileView from "#lib/ProfileView.svelte";
import type { PageProps } from "./$types";

// One Svelte profile view for both reads: /profile passes the viewer's own
// record, /members/:user passes the retrieved member. No markup lives here.
let { data }: PageProps = $props();
</script>

<ProfileView
  member={data.member}
  stats={data.stats}
  isOwner={data.isOwner}
  isModerator={data.isModerator}
  appUrl={data.appUrl}
  joinResult={data.joinResult}
  restoredWrite={data.restoredWrite}
/>
