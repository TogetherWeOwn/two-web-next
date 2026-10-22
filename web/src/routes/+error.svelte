<script lang="ts">
import { page } from "$app/state";
import ErrorShell from "#lib/ErrorShell.svelte";
import { adminWayBackForStatus } from "../../../src/admin-wayback";
import { FALLBACK_INVITE } from "../../../src/invite";
import { isKitErrorStatus } from "../../../src/kit-errors";

// Branded Kit error boundary: every Kit 400/404/403/410/422/429/500/503
// renders the shared shell with static copy. The failure itself is never
// echoed — message and trace stay in the logs, never in a member's browser —
// and the page reads no session and no database merely to offer recovery.
// Unknown statuses fall back to the 500 shell; data requests (__data.json)
// are answered by SvelteKit itself, so JSON/feed contracts are never
// swallowed here. noindex travels via the Shell robots prop.
// A throttled admin write additionally gets a way back to the refused form:
// derived from the status plus page.url, so the link survives the outage it
// reports. Only /admin paths on a 429 resolve; anything else renders the
// plain shell with no way back. The boundary never throws on a missing path:
// a harness-mocked page without url simply yields no way back.
const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);
const adminBack = $derived(adminWayBackForStatus(status, page.url?.pathname ?? ""));
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<ErrorShell code={status} inviteUrl={FALLBACK_INVITE} adminBack={adminBack} />
