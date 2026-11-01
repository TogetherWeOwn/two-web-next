<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import {
  formatActivityCauser,
  activityLogEmptyText,
  activityLogRecovery,
  activityLogUrl,
  type ActivityLogQuery,
} from "../../../../../src/admin/table-list";
import type { PageProps } from "./$types";

// Markup contract of ActivityLogPage (src/admin/pages/activity-log.tsx): the
// heading, the search field labels, the table testids, the scroll-region
// wiring, the empty copy and the paging testids are shared, so the existing
// admin E2E selectors still apply when this route owns traffic. Instants
// arrive pre-rendered as ISO strings from the load, exactly as the Hono page
// emits them inside <time datetime>. No island: the search is a plain GET
// form, so the no-JS viewer keeps working.
let { data }: PageProps = $props();
const { rows, query, hasNext } = $derived(data);
const emptyText = $derived(activityLogEmptyText(query as ActivityLogQuery));
const recovery = $derived(activityLogRecovery(query as ActivityLogQuery, rows.length));
const subjectOf = (row: {
  subjectType: string | null;
  subjectId: string | null;
  event: string;
}) => {
  const base =
    row.subjectType && row.subjectId
      ? `${row.subjectType} ${row.subjectId}`
      : row.subjectType || row.subjectId || "—";
  return row.event ? `${base} (${row.event})` : base;
};
</script>

<AdminShell title="Activity log">
  <section>
    <h1>Activity log</h1>
    <p class="hint">
      Read-only. Who changed what, when. Views that name a member are access-logged; imported
      causer IDs are labeled legacy.
    </p>
    <form method="get" action="/admin/activity-log" class="filters">
      <div class="field">
        <label for="subject">Subject</label>
        <input id="subject" name="subject" type="search" value={query.subject} />
      </div>
      <div class="field">
        <label for="causer">Causer</label>
        <input id="causer" name="causer" type="search" value={query.causer} />
      </div>
      <div class="field">
        <button type="submit" class="btn">Filter</button>
      </div>
    </form>
    <p id="activity-log-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the scroll region is intentionally keyboard-focusable so keyboard users can scroll the table on narrow screens (axe scrollable-region-focusable requires it). -->
    <div
      class="admin-table-scroll"
      role="region"
      aria-label="Activity log list"
      aria-describedby="activity-log-scroll-hint"
      tabindex="0"
      data-testid="activity-log-table-scroll"
    >
      <table class="admin-table" data-testid="activity-log-table">
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">When</th>
            <th scope="col">Subject</th>
          </tr>
        </thead>
        <tbody>
          {#if rows.length === 0}
            <tr>
              <td colspan={4} data-testid="activity-log-empty">{emptyText}</td>
            </tr>
          {:else}
            {#each rows as r (r.id)}
              <tr>
                <td>{formatActivityCauser(r.causerId)}</td>
                <td>{r.description}</td>
                <td><time datetime={r.createdAt}>{r.createdAt}</time></td>
                <td>{subjectOf(r)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if recovery.firstUrl || recovery.clearUrl}
      <p class="actions" data-testid="activity-log-recovery">
        {#if recovery.firstUrl}<a href={recovery.firstUrl}>First page of these results</a>{/if}
        {#if recovery.clearUrl}<a href={recovery.clearUrl}>Clear filters</a>{/if}
      </p>
    {/if}
    <nav aria-label="Activity pages" class="actions">
      {#if query.page > 1}
        <a rel="prev" href={activityLogUrl(query as ActivityLogQuery, query.page - 1)}>Previous</a>
      {/if}
      <span>Page {query.page}</span>
      {#if hasNext}
        <a rel="next" href={activityLogUrl(query as ActivityLogQuery, query.page + 1)}>Next</a>
      {/if}
    </nav>
  </section>
</AdminShell>
