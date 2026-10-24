<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";
import {
  eventListUrl,
  eventListHasFilters,
  eventListClearUrl,
  type EventSort,
} from "../../../../../src/admin/event-list";
import { goingCountText } from "../../../../../src/islands/contracts-going-count";
import type { KitEventListRow } from "../../../../../src/admin/kit-events";

// Markup contract of EventsPage (src/admin/pages/events-list.tsx): the
// search form, sort headers, fill badges, row actions, paging nav, empty
// states and testids are shared, so the existing admin E2E selectors still
// apply when this route owns traffic. Timestamps arrive pre-rendered as ISO
// strings from the load, exactly as the Hono page emits them. No island and
// no event handlers: every control is a plain GET form, sort/paging link or
// POST form to the Hono-owned mutation endpoints, so the page works with
// JavaScript disabled, exactly like the Hono panel.
let { data }: PageProps = $props();
const { query, rows, hasNext, emptyText } = $derived(data);
const now = new Date();
</script>

{#snippet sortHeader(label: string, sort: EventSort)}
  {@const active = query.sort === sort}
  {@const order = active && query.order === "asc" ? "desc" : "asc"}
  <th scope="col" aria-sort={active ? (query.order === "asc" ? "ascending" : "descending") : "none"}>
    <a
      href={eventListUrl(query, { sort, order, page: 1 })}
      aria-label={`Sort by ${label.toLowerCase()} ${order === "asc" ? "ascending" : "descending"}`}
    >
      {label}{active ? (query.order === "asc" ? " ↑" : " ↓") : ""}
    </a>
  </th>
{/snippet}

{#snippet fillCell(row: KitEventListRow)}
  <td data-testid={`event-fill-${row.eventKey}`}>
    {goingCountText(row.goingCount, row.capacity)}
    {#if row.capacity !== null && row.goingCount >= row.capacity}
      <span data-testid={`event-fill-badge-${row.eventKey}`}> Full</span>
    {/if}
    {#if row.capacity !== null && row.goingCount > row.capacity}
      <span data-testid={`event-over-capacity-${row.eventKey}`}> Over capacity</span>
    {/if}
  </td>
{/snippet}

<AdminShell title="Events">
<section aria-labelledby="events-heading">
  <h1 id="events-heading">Events</h1>
  <form method="get" action="/admin/events" class="filters">
    <input type="hidden" name="sort" value={query.sort} />
    <input type="hidden" name="order" value={query.order} />
    <div class="field">
      <label for="q">Search</label>
      <input id="q" name="q" type="search" value={query.q} />
    </div>
    <div class="field">
      <label for="status">Status</label>
      <select id="status" name="status">
        {#each ["", "draft", "published", "cancelled", "past"] as s (s)}
          <option value={s} selected={s === query.status}>{s === "" ? "All" : s}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <label for="rsvp_open">RSVPs</label>
      <select id="rsvp_open" name="rsvp_open">
        <option value="" selected={query.rsvp_open === ""}>All</option>
        <option value="1" selected={query.rsvp_open === "1"}>Open</option>
        <option value="0" selected={query.rsvp_open === "0"}>Paused</option>
      </select>
    </div>
    <div class="field">
      <label for="series">Series</label>
      <select id="series" name="series">
        {#each [["", "All"], ["parent", "Parent"], ["child", "Child"], ["standalone", "Standalone"]] as [value, label] (value)}
          <option value={value} selected={value === query.series}>{label}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <label for="fill">Fill</label>
      <select id="fill" name="fill">
        {#each [["", "All"], ["full", "Full"], ["has_seats", "Has seats"], ["unlimited", "Unlimited"]] as [value, label] (value)}
          <option value={value} selected={value === query.fill}>{label}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <button type="submit" class="btn">Filter</button>
    </div>
    {#if eventListHasFilters(query)}
      <div class="field">
        <a href={eventListClearUrl(query)}>Clear filters</a>
      </div>
    {/if}
  </form>
  <p>
    <a class="btn" href="/admin/events/new" data-testid="new-event">New event</a>
  </p>
  <p id="events-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
  <!-- Keyboard-scroll parity with the Hono panel (test/admin-table-scroll-parity.test.ts):
    the labelled scroll region stays Tab-focusable so keyboard users can arrow-scroll
    wide tables, per axe scrollable-region-focusable. The compiler cannot tell a
    labelled scroll region from a static div, hence the scoped ignore. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="admin-table-scroll"
    role="region"
    aria-label="Events list"
    aria-describedby="events-scroll-hint"
    tabindex={0}
    data-testid="events-table-scroll"
  >
    <table class="admin-table" data-testid="events-table">
      <thead>
        <tr>
          {@render sortHeader("Title", "title")}
          {@render sortHeader("Status", "status")}
          {@render sortHeader("Starts (UTC)", "starts_at")}
          <th scope="col">Fill</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#if rows.length === 0}
          <tr>
            <td colspan={5} data-testid="events-empty">{emptyText}</td>
          </tr>
        {:else}
          {#each rows as r (r.eventKey)}
            <tr>
              <td>
                <a href={`/admin/events/${r.eventKey}`}>{r.title}</a>
              </td>
              <td data-testid={`event-status-${r.eventKey}`}>{r.status}</td>
              <td>
                <time datetime={r.startsAt}>{r.startsAt}</time>
              </td>
              {@render fillCell(r)}
              <td>
                {#if r.status === "draft"}
                  <form method="post" action={`/admin/events/${r.eventKey}/publish`}>
                    <button type="submit" class="link">Publish</button>
                  </form>
                {/if}
                {#if r.status === "draft" || r.status === "published"}
                  <form method="post" action={`/admin/events/${r.eventKey}/cancel`}>
                    <button type="submit" class="link">Cancel</button>
                  </form>
                {/if}
                {#if r.status === "published" && new Date(r.endsAt) > now}
                  {@const action = r.rsvpOpen ? "rsvp-pause" : "rsvp-reopen"}
                  <form method="post" action={`/admin/events/${r.eventKey}/${action}`}>
                    <button type="submit" class="link" data-testid={action}>
                      {r.rsvpOpen ? "Pause RSVPs" : "Reopen RSVPs"}
                    </button>
                  </form>
                {/if}
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
  {#if rows.length === 0 && query.page > 1}
    <p>
      <a href={eventListUrl(query, { page: 1 })}>First page of these results</a>
    </p>
  {/if}
  <nav aria-label="Event pages" class="actions">
    {#if query.page > 1}
      <a rel="prev" href={eventListUrl(query, { page: query.page - 1 })}>Previous</a>
    {/if}
    <span>Page {query.page}</span>
    {#if hasNext}
      <a rel="next" href={eventListUrl(query, { page: query.page + 1 })}>Next</a>
    {/if}
  </nav>
</section>
</AdminShell>
