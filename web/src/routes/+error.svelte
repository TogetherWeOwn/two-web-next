<script lang="ts">
import { page } from "$app/state";
import ErrorShell from "#lib/ErrorShell.svelte";
import { FALLBACK_INVITE } from "../../../src/invite";
import { isKitErrorStatus } from "../../../src/kit-errors";

// Branded Kit error boundary: every Kit 400/404/403/410/422/429/500/503
// renders the shared shell with static copy. The failure itself is never
// echoed — message and trace stay in the logs, never in a member's browser —
// and the page reads no session and no database merely to offer recovery.
// Unknown statuses fall back to the 500 shell; data requests (__data.json)
// are answered by SvelteKit itself, so JSON/feed contracts are never
// swallowed here. noindex travels via the Shell robots prop.
const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<ErrorShell code={status} inviteUrl={FALLBACK_INVITE} />
