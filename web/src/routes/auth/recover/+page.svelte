<script lang="ts">
import Recovery from "#lib/Recovery.svelte";
import type { PageProps } from "./$types";

// Markup contract of the expired-session recovery (recoveryLanding in
// src/write-recovery.tsx): the whole RecoveryModel rides as data into the
// shared Recovery shell, so this page adds no copy of its own. Like the Hono
// page it ships no canonical link (transient outcome page) and no JavaScript
// (csr=false): the retry and invite anchors work with JS disabled.
let { data }: PageProps = $props();
</script>

<Recovery
  title={data.title}
  message={data.message}
  retryUrl={data.retryUrl}
  retryLabel={data.retryLabel}
  inviteUrl={data.inviteUrl}
/>
