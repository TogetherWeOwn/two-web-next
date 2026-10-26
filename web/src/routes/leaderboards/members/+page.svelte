<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../../src/seo";
import { utcPeriodShortcuts } from "../../../../../src/hotzones/season";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const { season, scope, activity, rows, viewerUsername, available, appUrl } = $derived(data);
// The load always provides neighbors; the fallback only guards a hand-built
// render, which shows no adjacent-period links like the all-time view.
const neighbors = $derived(
  data.neighbors ?? { previous: null, next: null },
);
const periods = utcPeriodShortcuts();
const label = $derived(activity === null ? "every game" : activity);
const destination = (nextScope: string, nextSeason = season) => {
  const params = new URLSearchParams();
  if (nextSeason !== "all") params.set("season", nextSeason);
  if (nextScope !== "overall") params.set("scope", nextScope);
  if (activity !== null) params.set("activity", activity);
  const query = params.toString();
  return query === "" ? "/leaderboards/members" : `/leaderboards/members?${query}`;
};
</script>

{#snippet memberChrome()}
  <form method="post" action="/logout">
    <span class="account-caption">Signed in</span>
    <span class="who">{viewerUsername}</span>
    <button type="submit" class="link">Sign out</button>
  </form>
{/snippet}

<Shell
  title="Member leaderboard"
  canonical={canonicalUrl(appUrl, "/leaderboards/members")}
  robots="noindex, nofollow"
  description="Members ranked by events attended."
  theme="schedule"
  activeNav="leaderboard"
  mainClass="events-page"
  loginReturnTo={destination(scope)}
  accountChrome={memberChrome}
>
  <p class="strap">Members only</p>
  <h1>Member leaderboard</h1>
  <p>Members ranked by events they answered going to, for season {season} and {label}. Members can opt out of leaderboards; see the <a href="/privacy">privacy policy</a>.</p>
  <nav aria-label="Board scope">
    <ul>
      <li><a href={destination("overall")} aria-current={scope === "overall" ? "page" : undefined}>Overall</a></li>
      <li><a href={destination("relative")} aria-current={scope === "relative" ? "page" : undefined}>Around you</a></li>
    </ul>
  </nav>
  <nav class="schedule-views board-periods" aria-label="Board period">
    <a href={destination(scope, periods.month)} aria-current={season === periods.month ? "page" : undefined}>This month</a>
    <a href={destination(scope, periods.quarter)} aria-current={season === periods.quarter ? "page" : undefined}>This quarter</a>
    <a href={destination(scope, "all")} aria-current={season === "all" ? "page" : undefined}>All time</a>
  </nav>
  {#if neighbors.previous !== null || neighbors.next !== null}
  <nav class="schedule-views board-periods" aria-label="Adjacent board periods">
    {#if neighbors.previous !== null}<a href={destination(scope, neighbors.previous)}>Previous period: {neighbors.previous}</a>{/if}
    {#if neighbors.next !== null}<a href={destination(scope, neighbors.next)}>Next period: {neighbors.next}</a>{/if}
  </nav>
  {/if}
  <form method="get" action="/leaderboards/members" aria-label="Filter the leaderboard">
    {#if scope !== "overall"}<input type="hidden" name="scope" value={scope} />{/if}
    <p>
      <label for="board-season">Season (all, 2026, 2026-09 or 2026-Q3)</label>
      <input id="board-season" name="season" type="text" value={season} />
    </p>
    <p>
      <label for="board-activity">Game (blank for every game)</label>
      <input id="board-activity" name="activity" type="text" value={activity ?? ""} />
    </p>
    <p><button class="btn" type="submit">Show board</button></p>
  </form>
  {#if !available}
    <p role="status">Rankings are temporarily unavailable.</p>
  {:else if rows.length === 0}
    <p role="status">{scope === "relative" ? "You are not ranked for this season and game yet." : "Nobody is ranked for this season and game yet."}</p>
  {:else}
    <table class="member-board-table">
      <caption>Going counts, season {season}, {label}</caption>
      <thead><tr><th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Going</th></tr></thead>
      <tbody>
        {#each rows as row}
          <tr aria-current={row.isViewer ? "true" : undefined}>
            <td>{row.rank}</td><th scope="row">{row.username}</th><td>{row.count}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Shell>
