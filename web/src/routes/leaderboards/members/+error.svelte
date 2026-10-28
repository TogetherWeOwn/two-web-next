<script lang="ts">
import { page } from "$app/state";
import ErrorShell from "#lib/ErrorShell.svelte";
import Shell from "#lib/Shell.svelte";
import { FALLBACK_INVITE } from "../../../../../src/invite";
import { isKitErrorStatus } from "../../../../../src/kit-errors";

// Route-level error page for GET /leaderboards/members: the load throws the
// helper's parse message with status 400 for a refused board-filter
// ("Unknown season", "Unknown scope", "The friends scope is deferred: there
// is no friend graph yet.", "Unknown activity"), so the 400 renders here in
// context — the board heading, the refused value in the parse message's own
// words, and Show-the-board + homepage recovery — mirroring Hono's
// MemberBoardFilterErrorPage (src/leaderboards/pages.tsx). Any other failure
// (403, 503, unexpected) keeps the shared shell with static copy, exactly as
// the root boundary. The failure itself is never echoed beyond the static
// parse message — trace stays in the logs — and the page
// reads no session and no database merely to offer recovery. The branded 400
// owns its robots meta through Shell; only the shell fallback needs one here.
const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);
const problem = $derived(
  page.status === 400
    ? typeof page.error?.message === "string" && page.error.message !== ""
      ? page.error.message
      : "Unknown season"
    : null,
);
const lead = $derived(
  problem === null
    ? ""
    : `${problem.endsWith(".") ? problem : `${problem}.`} Show the board without filters, or head back to the homepage.`,
);
</script>

<svelte:head>
  {#if problem === null}
    <meta name="robots" content="noindex, nofollow" />
  {/if}
</svelte:head>

{#if problem !== null}
  <Shell
    title="Board filters"
    robots="noindex, nofollow"
    theme="schedule"
    activeNav="leaderboard"
    mainClass="events-page"
    hideAccount
  >
    <p class="strap">Members only</p>
    <h1>Check the board filters</h1>
    <p class="lead">{lead}</p>
    <p class="recovery-actions">
      <a class="btn" href="/leaderboards/members" data-testid="error-board">Show the board</a>
      <a href="/" data-testid="error-home">Back to the homepage</a>
    </p>
  </Shell>
{:else}
  <ErrorShell code={status} inviteUrl={FALLBACK_INVITE} supportReference={page.data?.requestId} />
{/if}
