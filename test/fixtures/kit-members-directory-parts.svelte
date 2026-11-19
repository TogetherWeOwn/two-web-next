<script lang="ts">
import MembersDirectoryEmpty from "#lib/MembersDirectoryEmpty.svelte";
import MembersDirectoryHeader from "#lib/MembersDirectoryHeader.svelte";
import MembersDirectoryNewcomers from "#lib/MembersDirectoryNewcomers.svelte";
import MembersDirectoryRail from "#lib/MembersDirectoryRail.svelte";
import MembersDirectoryRows from "#lib/MembersDirectoryRows.svelte";
import type { MembersDirectoryView } from "#lib/members-directory";

export let data: MembersDirectoryView;
</script>

<MembersDirectoryHeader counts={data.counts} guest={data.audience === "guest"} />
{#if data.audience === "member"}
  <MembersDirectoryNewcomers newcomers={data.newcomers} />
  {#if data.rows.length}
    <MembersDirectoryRows rows={data.rows} />
  {:else}
    <MembersDirectoryEmpty directory={data} clearSearchHref="?filter=guides" everyoneHref="?filter=everyone" />
  {/if}
  <MembersDirectoryRail organizers={data.organizers} helpHref="/faq" />
{/if}
