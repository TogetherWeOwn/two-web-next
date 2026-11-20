<script lang="ts">
import MembersDirectoryAvatar from "./MembersDirectoryAvatar.svelte";
import Tag from "./Tag.svelte";
import type { MembersDirectoryView } from "./members-directory";

type Rows = Extract<MembersDirectoryView, { audience: "member" }>["rows"];
let { rows }: { rows: Rows } = $props();
const ranks = ["Prospect", "Member", "Soldier", "Veteran", "Legend"] as const;
// A7 uses the five clipped arcs of the Ember logo (Kit v0.3.1).
const arcs = [
  "M22 4a18 18 0 0 1 12.7 5.3",
  "M37.4 13.5a18 18 0 0 1 0 17",
  "M34.7 34.7A18 18 0 0 1 22 40",
  "M17.5 39.4a18 18 0 0 1-12.9-12",
  "M4.4 21.8A18 18 0 0 1 17.5 4.6",
];
</script>

<ul class="directory-rows" aria-label="Members" role="list">
  {#each rows as row (row.profileHref)}
    <li>
      <MembersDirectoryAvatar name={row.name} src={row.avatarUrl} />
      <div class="directory-name">
        <a href={row.profileHref}>{row.name}</a>
        <span class="directory-rank">
          <svg width="20" height="20" viewBox="0 0 44 44" aria-hidden="true" fill="none" stroke-width="4.5">
            {#each arcs as arc, i (arc)}
              <path d={arc} stroke={`var(--two-color-rank-arc-${i < row.rank ? i + 1 : "off"})`} />
            {/each}
          </svg>
          {ranks[row.rank - 1]}
        </span>
      </div>
      <div class="directory-games">{#each row.games as game}<span>{game}</span>{/each}</div>
      <div class="directory-seen">{row.lastSeen ?? ""}</div>
      {#if row.role}<div class="directory-role"><Tag>{row.role}</Tag></div>{/if}
    </li>
  {/each}
</ul>

<style>
  ul { margin: 0; padding: 0; list-style: none; }
  li {
    position: relative;
    display: grid;
    grid-template-columns: var(--two-size-avatar-lg) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 150px) auto;
    align-items: center;
    gap: var(--space-4);
    min-height: var(--two-size-row-calm);
    padding: var(--two-space-inset-tight) var(--space-3);
    border-block-start: 1px solid var(--two-color-line-hairline);
    overflow-wrap: anywhere;
  }
  a { color: var(--t1); font-weight: var(--font-weight-semibold); }
  a::after { position: absolute; inset: 0; content: ""; }
  li:focus-within { outline: var(--focus-width) solid var(--focus-ring); outline-offset: calc(-1 * var(--focus-width)); }
  .directory-rank { display: flex; align-items: center; gap: var(--space-2); color: var(--t3); font-size: 13px; }
  svg { flex: none; }
  .directory-games { display: flex; gap: var(--space-1); flex-wrap: wrap; }
  .directory-games span { padding: var(--space-1) var(--space-2); border-radius: var(--radius-s); background: var(--g2); color: var(--t2); font-size: 13px; }
  .directory-seen { color: var(--t3); font: 13px/1.3 var(--font-data); }
  @media (max-width: 820px) {
    li { grid-template-columns: var(--two-size-avatar-lg) minmax(0, 1fr) auto; gap: var(--space-1) var(--space-3); }
    .directory-games, .directory-seen { grid-column: 2 / -1; }
    .directory-role { grid-column: 3; grid-row: 1; align-self: start; }
  }
</style>
