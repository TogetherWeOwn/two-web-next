<script lang="ts">
import type { PageProps } from "./$types";
import { featuredListUrl } from "../../../../../src/admin/table-list";

// Markup contract of FeaturedPage (src/admin/pages/featured-list.tsx): the
// new/edit destinations, the GET filter form, the sortable position and
// last-changed headers, the row testids, the UTC window bounds, the
// scroll-hint region and the prev/next pagination are shared, so the
// existing admin E2E selectors still apply when this route owns traffic.
// Rows arrive from the load with datetimes pre-rendered as ISO strings and
// the publish/window status resolved through the shared featuredStatus(),
// exactly as the Hono page emits them. No JavaScript: the filter form is a
// plain GET and every sort/page change is a link.
let { data }: PageProps = $props();
const { rows, query, hasNext, emptyText } = $derived(data);
const positionNext = $derived(query.sort === "position" && query.order === "asc" ? "desc" : "asc");
const updatedNext = $derived(query.sort === "updated_at" && query.order === "asc" ? "desc" : "asc");
</script>

<section>
  <h1>Featured content</h1>
  <p>
    <a class="btn" href="/admin/featured/new" data-testid="new-featured">New featured slot</a>
  </p>
  <form method="get" action="/admin/featured" class="filters">
    <input type="hidden" name="sort" value={query.sort} />
    <input type="hidden" name="order" value={query.order} />
    <div class="field">
      <label for="q">Search titles</label>
      <input id="q" name="q" type="search" value={query.q} />
    </div>
    <div class="field">
      <label for="published">Published</label>
      <select id="published" name="published">
        <option value="" selected={query.published === ""}>All</option>
        <option value="1" selected={query.published === "1"}>Published</option>
        <option value="0" selected={query.published === "0"}>Unpublished</option>
      </select>
    </div>
    <div class="field">
      <button type="submit" class="btn">Filter</button>
    </div>
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
          <th
            scope="col"
            aria-sort={query.sort === "position"
              ? query.order === "asc"
                ? "ascending"
                : "descending"
              : "none"}
          >
            <a
              href={featuredListUrl(query, { sort: "position", order: positionNext, page: 1 })}
              aria-label={`Sort by position ${positionNext === "asc" ? "ascending" : "descending"}`}
            >
              Position{query.sort === "position" ? (query.order === "asc" ? " ↑" : " ↓") : ""}
            </a>
          </th>
          <th scope="col">Window (UTC)</th>
          <th
            scope="col"
            aria-sort={query.sort === "updated_at"
              ? query.order === "asc"
                ? "ascending"
                : "descending"
              : "none"}
          >
            <a
              href={featuredListUrl(query, { sort: "updated_at", order: updatedNext, page: 1 })}
              aria-label={`Sort by last changed ${updatedNext === "asc" ? "ascending" : "descending"}`}
            >
              Last changed{query.sort === "updated_at"
                ? query.order === "asc"
                  ? " ↑"
                  : " ↓"
                : ""}
            </a>
          </th>
        </tr>
      </thead>
      <tbody>
        {#if rows.length === 0}
          <tr>
            <td colspan={5} data-testid="featured-empty">{emptyText}</td>
          </tr>
        {:else}
          {#each rows as r (r.id)}
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
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
  <nav aria-label="Featured content pages" class="actions">
    {#if query.page > 1}
      <a rel="prev" href={featuredListUrl(query, { page: query.page - 1 })}>Previous</a>
    {/if}
    <span>Page {query.page}</span>
    {#if hasNext}
      <a rel="next" href={featuredListUrl(query, { page: query.page + 1 })}>Next</a>
    {/if}
  </nav>
</section>
