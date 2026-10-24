<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import {
  featuredListUrl,
  featuredListHasFilters,
  featuredListClearUrl,
} from "../../../../../src/admin/featured-list-query";
import type { PageProps } from "./$types";

// Markup contract of FeaturedPage (src/admin/pages/featured-list.tsx): the
// new/edit destinations, the GET search form, the sortable position and
// last-changed headers, the row testids, the UTC window bounds, the
// scroll-hint region and the prev/next pagination are shared, so the
// existing admin E2E selectors still apply when this route owns traffic.
// Rows arrive from the load with datetimes pre-rendered as ISO strings and
// the publish/window status resolved through the shared featuredStatus(),
// exactly as the Hono page emits them. No JavaScript: the search form is a
// plain GET and every sort/page change is a link.
let { data }: PageProps = $props();
</script>

{#snippet sortHeading(header: PageProps["data"]["positionHeader"])}
  <th scope="col" aria-sort={header.ariaSort}>
    <a href={header.href} aria-label={header.ariaLabel}>{header.text}</a>
  </th>
{/snippet}

<AdminShell title="Featured content" restoredWrite={data.restoredWrite}>
<section>
  <h1>Featured content</h1>
  <p>
    <a class="btn" href="/admin/featured/new" data-testid="new-featured">New featured slot</a>
  </p>
  <form method="get" action="/admin/featured" class="filters">
    <input type="hidden" name="sort" value={data.query.sort} />
    <input type="hidden" name="order" value={data.query.order} />
    <div class="field">
      <label for="q">Search titles</label>
      <input id="q" name="q" type="search" value={data.query.q} />
    </div>
    <div class="field">
      <label for="published">Published</label>
      <select id="published" name="published">
        <option value="" selected={data.query.published === ""}>All</option>
        <option value="1" selected={data.query.published === "1"}>Published</option>
        <option value="0" selected={data.query.published === "0"}>Unpublished</option>
      </select>
    </div>
    <div class="field">
      <button type="submit" class="btn">Filter</button>
    </div>
    {#if featuredListHasFilters(data.query)}
      <div class="field">
        <a href={featuredListClearUrl(data.query)}>Clear filters</a>
      </div>
    {/if}
  </form>
  <p id="featured-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: keyboard-scrollable
    region per the Hono contract (src/admin/pages/featured-list.tsx) — the
    wide table scrolls horizontally on small screens and the hint above names
    this region, so keyboard users need the tab stop. -->
  <div
    class="featured-table-scroll"
    role="region"
    aria-label="Featured content list"
    aria-describedby="featured-scroll-hint"
    tabindex={0}
    data-testid="featured-table-scroll"
  >
    <table class="admin-table featured-table" data-testid="featured-table">
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">Status</th>
          {@render sortHeading(data.positionHeader)}
          <th scope="col">Window (UTC)</th>
          {@render sortHeading(data.updatedHeader)}
        </tr>
      </thead>
      <tbody>
        {#each data.rows as r (r.id)}
          <tr>
            <td><a href={`/admin/featured/${r.id}`}>{r.title}</a></td>
            <td data-testid={`featured-status-${r.id}`}>
              <span class="featured-status featured-status-{r.status}" data-status={r.status}>
                {r.status}
              </span>
            </td>
            <td data-testid={`featured-position-${r.id}`}>{r.position}</td>
            <td>
              <span class="featured-window-bound">
                {#if r.startsAt}<time datetime={r.startsAt}>{r.startsAt}</time>{:else}—{/if}
              </span>
              <span class="featured-window-bound">
                → {#if r.endsAt}<time datetime={r.endsAt}>{r.endsAt}</time>{:else}—{/if}
              </span>
            </td>
            <td><time datetime={r.updatedAt}>{r.updatedAt}</time></td>
          </tr>
        {:else}
          <tr>
            <td colspan={5} data-testid="featured-empty">{data.emptyText}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if data.rows.length === 0 && data.query.page > 1}
    <p>
      <a href={featuredListUrl(data.query, { page: 1 })}>First page of these results</a>
    </p>
  {/if}
  <nav aria-label="Featured content pages" class="actions">
    {#if data.previousHref}
      <a rel="prev" href={data.previousHref}>Previous</a>
    {/if}
    <span>Page {data.query.page}</span>
    {#if data.nextHref}
      <a rel="next" href={data.nextHref}>Next</a>
    {/if}
  </nav>
</section>
</AdminShell>
