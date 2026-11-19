<script lang="ts">
import EmberShell from "#lib/EmberShell.svelte";
import RankLabel from "#lib/RankLabel.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
</script>

<SiteMetadata title="Member ranks" theme="home" />
<EmberShell member={false}>
  <h1>Member ranks</h1>
  {#each [false, true] as large (large)}
    <section>
      <h2>{large ? "Profile ranks" : "Inline ranks"}</h2>
      <ul role="list">
        {#each [1, 2, 3, 4, 5] as const as rank (rank)}
          <li><RankLabel {rank} {large} /></li>
        {/each}
      </ul>
    </section>
  {/each}
</EmberShell>

<style>
  section { margin-block: var(--space-4); }
  ul { display: flex; flex-wrap: wrap; gap: var(--space-4); padding: 0; list-style: none; }
</style>
