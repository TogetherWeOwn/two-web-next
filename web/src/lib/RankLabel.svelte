<script lang="ts">
let { rank, large = false }: { rank: 1 | 2 | 3 | 4 | 5; large?: boolean } = $props();

const ranks = ["Prospect", "Member", "Soldier", "Veteran", "Legend"];
const arcs = [
  "M22 4a18 18 0 0 1 12.7 5.3",
  "M37.4 13.5a18 18 0 0 1 0 17",
  "M34.7 34.7A18 18 0 0 1 22 40",
  "M17.5 39.4a18 18 0 0 1-12.9-12",
  "M4.4 21.8A18 18 0 0 1 17.5 4.6",
];
</script>

<span class="rank-label">
  <svg class:large viewBox="0 0 44 44" aria-hidden="true">
    <g fill="none" stroke-width="4.5">
      {#each arcs as arc, index}
        <path d={arc} class:lit={index < rank} />
      {/each}
    </g>
  </svg>
  <span>{ranks[rank - 1]}</span>
</span>

<style>
  .rank-label { display: inline-flex; align-items: center; gap: var(--two-space-2); }
  svg { width: 20px; height: 20px; flex: none; }
  svg.large { width: 44px; height: 44px; }
  path { stroke: var(--two-color-rank-arc-off); }
  path.lit:nth-child(1) { stroke: var(--two-color-rank-arc-1); }
  path.lit:nth-child(2) { stroke: var(--two-color-rank-arc-2); }
  path.lit:nth-child(3) { stroke: var(--two-color-rank-arc-3); }
  path.lit:nth-child(4) { stroke: var(--two-color-rank-arc-4); }
  path.lit:nth-child(5) { stroke: var(--two-color-rank-arc-5); }
  @media (forced-colors: active) {
    path { stroke: GrayText; }
    path.lit:nth-child(n) { stroke: CanvasText; }
  }
</style>
