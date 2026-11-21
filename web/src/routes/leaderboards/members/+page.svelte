<script lang="ts">
import Chip from "#lib/Chip.svelte";
import SegmentedControl from "#lib/SegmentedControl.svelte";
import Shell from "#lib/Shell.svelte";
import { parseSeasonParam, utcPeriodShortcuts } from "../../../../../src/hotzones/season";
import type { MembersBoardRow } from "../../../../../src/kit-members";
import { boardCaption } from "../../../../../src/leaderboards/captions";
import { canonicalUrl } from "../../../../../src/seo";
import "../../../../../vendor/design-kit/tokens.css";
import "../../../lib/segmented-control.css";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const { season, scope, activity, viewerUsername, available, appUrl } = $derived(data);
const rows: MembersBoardRow[] = $derived(data.rows);
const activityInput = $derived(data.activityInput ?? activity);
const now = new Date();
const periods = utcPeriodShortcuts(now);
const seasonWindow = $derived(parseSeasonParam(season));
const dayMs = 86_400_000;
const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });
const dateWithEra = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  era: "short",
  timeZone: "UTC",
});
const formatDate = (date: Date) =>
  (date.getUTCFullYear() < 1 ? dateWithEra : dateFormat).format(date);
const seasonTiming = $derived.by(() => {
  if (seasonWindow?.kind !== "window") return null;
  const { start, end } = seasonWindow;
  const days = (end.getTime() - start.getTime()) / dayMs;
  const elapsed = (now.getTime() - start.getTime()) / dayMs;
  return {
    days,
    ended: elapsed >= days,
    elapsed: Math.max(0, Math.min(days, elapsed)),
    label:
      elapsed < 0
        ? "Not started"
        : elapsed >= days
          ? "Ended"
          : `Day ${Math.floor(elapsed) + 1} of ${days}`,
    boundary:
      elapsed < 0
        ? `Starts ${formatDate(start)}`
        : elapsed >= days
          ? `Ended ${formatDate(end)}`
          : `Resets ${formatDate(end)}`,
  };
});

// Label only visible equal counts; keep the reader's positions at both window edges.
const ties = $derived(
  rows.map((row, i) => rows[i - 1]?.count === row.count || rows[i + 1]?.count === row.count),
);
const destination = (
  nextScope: string,
  nextSeason = season,
  nextActivity: string | null = activityInput,
) => {
  const params = new URLSearchParams();
  if (nextSeason !== "all") params.set("season", nextSeason);
  if (nextScope !== "overall") params.set("scope", nextScope);
  if (nextActivity !== null) params.set("activity", nextActivity);
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
  restoredWrite={data.restoredWrite}
  title="Member leaderboard"
  canonical={canonicalUrl(appUrl, "/leaderboards/members")}
  robots="noindex, nofollow"
  description="Members ranked by events they signed up for as going."
  theme="schedule"
  activeNav="leaderboard"
  mainClass="events-page"
  loginReturnTo={destination(scope)}
  accountChrome={memberChrome}
>
  <div class="board-heading">
    <p class="board-mono">{season === "all" ? "All time" : `Season ${season}`} · Members only</p>
    <h1>Member leaderboard</h1>
    <p>Ranked by events signed up for (going), not by attendance.</p>
    {#if seasonTiming}
      <div class="season-timing">
        <div class="season-labels board-mono">
          <span>{seasonTiming.label}</span><span>{seasonTiming.boundary} (UTC)</span>
        </div>
        <progress aria-label="Season elapsed" max={seasonTiming.days} value={seasonTiming.elapsed}></progress>
      </div>
    {/if}
  </div>
  <div class="board-toolbar">
    <SegmentedControl label="Board scope" items={[
      { href: destination("overall"), label: "Overall", current: scope === "overall" },
      { href: destination("relative"), label: "Around you", current: scope === "relative" },
    ]} />
    <nav class="board-games" aria-label="Board game">
      <Chip href={destination(scope, season, null)} selected={activity === null}>Every game</Chip>
      {#if activityInput !== null}<Chip href={destination(scope)} selected>{activityInput}</Chip>{/if}
    </nav>
  </div>
  <nav class="schedule-views board-periods" aria-label="Board period">
    <a href={destination(scope, periods.month)} aria-current={season === periods.month ? "page" : undefined}>This month</a>
    <a href={destination(scope, periods.quarter)} aria-current={season === periods.quarter ? "page" : undefined}>This quarter</a>
    <a href={destination(scope, "all")} aria-current={season === "all" ? "page" : undefined}>All time</a>
  </nav>
  <p>Manage leaderboard visibility in your <a href="/profile">profile settings</a>.</p>
  <form class="board-filters" method="get" action="/leaderboards/members" aria-label="Filter the leaderboard">
    {#if scope !== "overall"}<input type="hidden" name="scope" value={scope} />{/if}
    <label for="board-season">Season (all, 2026, 2026-09 or 2026-Q3)
      <input id="board-season" name="season" type="text" value={season} />
    </label>
    <label for="board-activity">Game (blank for every game)
      <input id="board-activity" name="activity" type="text" value={activityInput ?? ""} />
    </label>
    <button class="btn" type="submit">Show board</button>
  </form>

  <div class="board-layout">
    <div>
      {#if !available}
        <p class="board-panel" role="status">Rankings are temporarily unavailable.</p>
      {:else if rows.length === 0}
        <p class="board-panel" role="status">
          {scope === "relative" ? "You are not" : "Nobody is"} ranked for this season and game{seasonTiming?.ended ? "." : " yet."}
          {#if scope === "relative"}See the <a href={destination("overall")}>overall board</a>.{/if}
          {#if seasonTiming?.ended}
            This season has ended. Try the <a href={destination("overall", "all", null)}>all-time board</a>.
          {:else}
            Answer going to get ranked for an <a href="/events">event</a> scheduled in this period.
          {/if}
          {#if scope === "overall" && activity !== null}Or <a href={destination(scope, season, null)}>show every game</a>.{/if}
        </p>
      {:else}
        {#if scope === "overall"}
          <ol class="board-leaders" role="list" aria-label="Leading sign-up counts">
            {#each rows.slice(0, 3) as row, i (row.rank)}
              <li class="board-panel" class:leader-first={row.rank === 1}>
                <span class="leader-position">{row.rank}</span>
                <strong>{row.username}{row.isViewer ? " (you)" : ""}</strong>
                <span class="board-mono">{row.count} {row.count === 1 ? "sign-up" : "sign-ups"}{ties[i] ? " · Tied" : ""}</span>
              </li>
            {/each}
          </ol>
        {/if}
        <table class="member-board-table">
          <caption>{boardCaption({ season, scope, activity })}</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Going</th></tr></thead>
          <tbody>
            {#each rows as row, i (row.rank)}
              <tr aria-current={row.isViewer ? "true" : undefined}>
                <td>{row.rank}</td><th scope="row">{row.username}</th><td>{row.count}{ties[i] ? " · Tied" : ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
    <aside aria-labelledby="how-it-counts" class="board-panel">
      <h2 id="how-it-counts">How it counts</h2>
      <p>The board counts current Going sign-ups for published or past events, in the period of the event’s scheduled start. It does not count attendance.</p>
      <p>Read the <a href="/privacy">privacy policy</a> for more about leaderboard visibility.</p>
    </aside>
  </div>
</Shell>

<style>
  .board-heading { padding-block: var(--two-space-9) var(--two-space-8); }
  .board-heading :global(h1) { font-size: var(--two-font-size-h1); text-transform: none; }
  .board-heading > p:last-of-type { font-size: var(--two-font-size-lede); }
  .board-mono { font-family: var(--two-font-data); color: var(--two-color-text-secondary); font-size: var(--two-font-size-small); }
  .season-timing { margin-top: var(--two-space-6); }
  .season-labels { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--two-space-2); }
  progress { display: block; width: 100%; height: var(--two-radius-s); margin-top: var(--two-space-2); accent-color: var(--two-color-text-secondary); }
  .board-toolbar, .board-games, .board-filters { display: flex; flex-wrap: wrap; gap: var(--two-space-3); align-items: center; }
  .board-toolbar {
    padding-block: var(--two-space-inset-room);
    background: var(--two-color-bg-canvas);
    border-bottom: 1px solid var(--two-color-line-hairline);
  }
  .board-games :global(a) { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .board-filters { align-items: end; margin-top: var(--two-space-4); }
  .board-filters label { display: grid; gap: var(--two-space-2); min-width: 0; }
  .board-filters input {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--two-size-control-md);
    padding-inline: var(--two-space-3);
    background: var(--two-color-bg-surface);
    color: var(--two-color-text-primary);
    border: 1px solid var(--two-control-border);
    border-radius: var(--two-radius-s);
  }
  .board-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(var(--two-layout-rail-min), var(--two-layout-rail-default));
    gap: var(--two-space-9);
    align-items: start;
    padding-block: var(--two-space-7) var(--two-space-section);
  }
  .board-panel {
    margin: 0;
    padding: var(--two-space-5);
    background: var(--two-color-bg-surface);
    border: 1px solid var(--two-color-line-hairline);
    border-radius: var(--two-radius-l);
  }
  aside h2 { font-size: var(--two-font-size-body-reading); margin: 0; }
  aside p { margin-bottom: 0; }
  .board-leaders { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--two-space-3); margin: 0 0 var(--two-space-6); padding: 0; list-style: none; }
  .board-leaders li { display: grid; gap: var(--two-space-2); overflow-wrap: anywhere; }
  .leader-position { font: var(--two-font-weight-medium) var(--two-font-size-figure)/1 var(--two-font-display); color: var(--two-color-text-tertiary); }
  .leader-first .leader-position { color: var(--two-color-text-accent); }
  .board-layout :global(.member-board-table) { width: 100%; border-collapse: collapse; text-align: left; }
  .board-layout :global(.member-board-table caption) { text-align: left; font-family: var(--two-font-data); font-size: var(--two-font-size-small); margin-bottom: var(--two-space-2); overflow-wrap: anywhere; }
  .board-layout :global(.member-board-table :is(td, th)) {
    height: var(--two-size-row-table);
    padding-inline: var(--two-space-3);
    vertical-align: middle;
    border: 0;
    border-bottom: 1px solid var(--two-color-line-hairline);
    overflow-wrap: anywhere;
  }
  .board-layout :global(.member-board-table thead th) {
    top: var(--two-layout-sticky-offset);
    background: var(--two-color-bg-surface);
  }
  .board-layout :global(.member-board-table td) { font-variant-numeric: tabular-nums; }
  .board-layout :global(.member-board-table :is(td, th):last-child) { text-align: right; }
  .board-layout :global(.member-board-table tr[aria-current="true"] > *) { background: var(--two-color-bg-raised); }
  .board-layout :global(.member-board-table tr[aria-current="true"] > td:first-child) { box-shadow: inset 2px 0 var(--two-color-accent-default); }

  @media (max-width: 820px) {
    .board-heading { padding-block: var(--two-space-7) var(--two-space-6); }
    /* Match the mobile shell’s scroll padding (site-header.css). */
    .board-layout :global(.member-board-table thead th) { top: 12rem; }
    .board-layout { grid-template-columns: minmax(0, 1fr); gap: var(--two-space-7); padding-bottom: var(--two-space-section-compact); }
    .board-leaders { grid-template-columns: minmax(0, 1fr); }
    .board-leaders li { grid-template-columns: auto minmax(0, 1fr); column-gap: var(--two-space-4); }
    .leader-position { grid-row: span 2; align-self: center; font-size: var(--two-font-size-figure-compact); }
    .board-layout :global(.member-board-table :is(td, th)) { height: var(--two-size-row-dense); padding-inline: var(--two-space-2); }
  }

  @media (forced-colors: active) {
    .board-layout :global(.member-board-table tr[aria-current="true"] > td:first-child) { border-inline-start: 2px solid Highlight; }
  }
</style>
