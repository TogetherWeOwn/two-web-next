<script lang="ts">
import { page } from "$app/state";
import ErrorShell from "#lib/ErrorShell.svelte";
import EventGone from "#lib/EventGone.svelte";
import EventMissing from "#lib/EventMissing.svelte";
import { FALLBACK_INVITE } from "../../../../../src/invite";
import { isKitErrorStatus } from "../../../../../src/kit-errors";

// Route-level error page for GET /e/:key: the load throws the branded #838
// state models with the served statuses (410 cancelled, 404 unknown), so they
// render here with their alternatives/suggestions, ICS entry and structured
// data instead of the generic shell. Any other failure (403, 503, unexpected)
// keeps the shared shell with static copy, exactly as the root boundary. The
// branded states own their robots meta through Shell; only the shell fallback
// needs one here.
const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);
const gone = $derived(page.status === 410 ? page.error?.gone : undefined);
const missing = $derived(page.status === 404 ? page.error?.missing : undefined);
</script>

<svelte:head>
  {#if !gone && !missing}
    <meta name="robots" content="noindex, nofollow" />
  {/if}
</svelte:head>

{#if gone}
  <EventGone model={gone} />
{:else if missing}
  <EventMissing model={missing} />
{:else}
  <ErrorShell code={status} inviteUrl={FALLBACK_INVITE} supportReference={page.data.requestId} />
{/if}
