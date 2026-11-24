<script lang="ts">
import "../../../vendor/design-kit/tokens.css";
import "./segmented-control.css";
import Button from "./Button.svelte";
import EmberShell from "./EmberShell.svelte";
import MembersDirectoryEmpty from "./MembersDirectoryEmpty.svelte";
import MembersDirectoryHeader from "./MembersDirectoryHeader.svelte";
import MembersDirectoryNewcomers from "./MembersDirectoryNewcomers.svelte";
import MembersDirectoryRail from "./MembersDirectoryRail.svelte";
import MembersDirectoryRows from "./MembersDirectoryRows.svelte";
import SegmentedControl from "./SegmentedControl.svelte";
import {
  MEMBER_FILTERS,
  MEMBER_SEARCH_LIMIT,
  type MembersDirectoryView,
} from "./members-directory";

let {
  directory,
  action,
  helpHref,
  fixtureState,
}: {
  directory: MembersDirectoryView;
  action: string;
  helpHref: string;
  fixtureState?: string;
} = $props();
const names = { active: "Active", everyone: "Everyone", guides: "Guides" };

function href(filter = "active", query = "", page = 1) {
  const params = new URLSearchParams();
  if (fixtureState) params.set("state", fixtureState);
  if (filter !== "active") params.set("filter", filter);
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  return params.size ? `${action}?${params}` : action;
}
</script>

{#snippet memberAccount()}
  <a href="/profile">Your profile</a>
{/snippet}

<EmberShell
  member={directory.audience === "member"}
  accountChrome={directory.audience === "member" ? memberAccount : undefined}
>
  <MembersDirectoryHeader counts={directory.counts} guest={directory.audience === "guest"} />
  {#if directory.audience === "member"}
    {@const { filter, query, page } = directory.selection}
    <MembersDirectoryNewcomers newcomers={directory.newcomers} />
    <div class="directory-toolbar">
      <form method="get" {action} role="search" aria-label="Search members">
        {#if fixtureState}<input type="hidden" name="state" value={fixtureState} />{/if}
        {#if filter !== "active"}<input type="hidden" name="filter" value={filter} />{/if}
        <label class="sr-only" for="directory-search">Find by name or Discord handle</label>
        <input id="directory-search" type="search" name="q" value={query} maxlength={MEMBER_SEARCH_LIMIT} placeholder="Name or Discord handle" />
        <Button type="submit" size="sm">Search</Button>
      </form>
      <SegmentedControl label="Which members" items={MEMBER_FILTERS.map((choice) => ({
        href: href(choice, query), label: names[choice], current: choice === filter, count: directory.filterCounts[choice],
      }))} />
      {#if directory.rows.length}<p class="directory-order">Recently active first</p>{/if}
    </div>
    <div class="directory-columns">
      <div class="directory-results">
        {#if directory.rows.length}
          {#if query}<Button href={href(filter)} size="sm">Clear search</Button>{/if}
          <MembersDirectoryRows rows={directory.rows} />
          {#if directory.pageCount > 1}
            <nav class="directory-pagination" aria-label="Member pages">
              {#if page > 1}<Button size="sm" href={href(filter, query, page - 1)}>Previous page</Button>{/if}
              <span>Page {page} of {directory.pageCount}</span>
              {#if page < directory.pageCount}<Button size="sm" href={href(filter, query, page + 1)}>Next page</Button>{/if}
            </nav>
          {/if}
        {:else}
          <MembersDirectoryEmpty {directory} clearSearchHref={href(filter)} everyoneHref={href("everyone")} />
        {/if}
      </div>
      <MembersDirectoryRail organizers={directory.organizers} {helpHref} />
    </div>
  {/if}
</EmberShell>

<style>
  .directory-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding-block: var(--two-space-inset-room);
    border-block-end: 1px solid var(--two-color-line-hairline);
    background: var(--color-page);
  }
  /* On short viewports, leave the toolbar in flow so focused results stay visible. */
  @media (height > 360px) {
    .directory-toolbar { position: sticky; top: var(--two-size-header-wide); z-index: 1; }
    :global(html:has(.directory-toolbar)) { scroll-padding-block-start: calc(100px + var(--two-size-header-wide)); }
  }
  form { display: flex; align-items: center; gap: var(--space-2); flex: 1 1 280px; max-width: 420px; }
  input[type="search"] {
    flex: 1;
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: var(--two-size-control-md);
    padding-inline: var(--two-space-inset-room);
    border: 1px solid var(--two-color-line-control);
    border-radius: var(--radius-m);
    background: var(--two-color-bg-canvas);
    color: var(--t1);
    font: var(--two-font-size-ui)/1.2 var(--font-ui);
  }
  input::placeholder { color: var(--t3); opacity: 1; }
  input:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
  .directory-order { margin: 0 0 0 auto; color: var(--t3); font: var(--text-label)/1.3 var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .directory-columns { display: grid; grid-template-columns: minmax(0, 1fr) var(--two-layout-rail-min); gap: var(--two-space-8); padding-block: var(--space-3) var(--space-11); }
  .directory-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding-block: var(--space-3); }
  @media (max-width: 820px) and (height > 360px) {
    /* Override the compact header's scroll inset to clear both sticky bars. */
    :global(html:root:has(.directory-toolbar)) { scroll-padding-block-start: 240px; }
    .directory-toolbar { top: var(--two-size-header-compact); }
    /* The toolbar sticks to the viewport edge with the in-flow fragment menu. */
    :global(.base-theme:has(> [data-kit-site-header]:target:not([data-menu-ready]))) .directory-toolbar { top: 0; }
  }
  @media (max-width: 820px) {
    .directory-toolbar { flex-direction: column; align-items: stretch; }
    form { flex: auto; max-width: none; }
    .directory-toolbar :global(.segments > a) { flex: 1; padding-inline: var(--space-2); }
    .directory-order { margin-inline: 0; }
    .directory-columns { grid-template-columns: minmax(0, 1fr); gap: var(--space-7); padding-block-end: var(--space-9); }
  }
</style>
