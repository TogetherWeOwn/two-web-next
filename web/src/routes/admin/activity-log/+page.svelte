<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import { formatAdminTime } from "../../../../../src/admin/chronology";
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
// arrive as exact ISO strings (or null for unusable timestamps) from the
// load. The shared adapter labels valid instants in UTC, like Hono. No
// island: the search is a plain GET form, so the no-JS viewer keeps working.
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

<AdminShell restoredWrite={data.restoredWrite} title="Activity log">
  <section>
    <h1>Activity log</h1>
    <p class="hint">
      Read-only. Who changed what, when (UTC). Views that name a member are access-logged; imported
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
            <th scope="col">When (UTC)</th>
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
              {@const time = formatAdminTime(r.createdAt)}
              <tr>
                <td>{formatActivityCauser(r.causerId)}</td>
                <td>{r.description}</td>
                <td class="admin-chronology">{#if time.iso}<time datetime={time.iso}>{time.label}</time>{:else}{time.label}{/if}</td>
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

<style>
  section {
    border-color: var(--color-hair2);
    padding-block: var(--space-6);
    font: var(--text-small) / var(--leading-body) var(--font-ui);
  }

  /* Anchor to this page's section without changing the shared HTML contract. */
  section :global {
    h1 {
      margin-block: 0 var(--space-3);
      font: var(--font-weight-display) var(--text-h3) / var(--leading-heading) var(--font-display);
      letter-spacing: var(--tracking-h3);
    }

    .hint, #activity-log-scroll-hint {
      color: var(--color-lobby-muted);
      font-size: inherit;
    }

    .filters, .actions {
      flex-wrap: wrap;
      gap: var(--space-3);
    }

    .filters .field {
      min-inline-size: 0;
    }

    .field label {
      margin-block-end: var(--space-1);
      font-weight: var(--font-weight-semibold);
    }

    .field input {
      padding: var(--space-2) var(--space-3);
      color: var(--color-lobby-ink);
      background: var(--color-lobby-raised);
      border: 1px solid var(--color-lobby-line);
      border-radius: var(--radius-s);
    }

    .filters .btn {
      padding-inline: var(--space-4);
      color: var(--color-lobby-on-accent);
      background: var(--color-lobby-accent);
      border: 1px solid transparent;
      border-radius: var(--radius-s);
      font: inherit;
      font-weight: var(--font-weight-semibold);
      letter-spacing: normal;
      text-transform: none;
    }

    .filters .btn:hover {
      background: var(--color-accent-hi);
    }

    .admin-table-scroll {
      scrollbar-color: var(--color-lobby-line) var(--color-lobby-surface);
    }

    .admin-table {
      border-collapse: separate;
      border-spacing: 0;
    }

    .admin-table :is(th, td) {
      padding: var(--space-2) var(--space-3);
      border-color: var(--color-hair2);
    }

    .admin-table th {
      background: var(--color-lobby-raised);
      font-weight: var(--font-weight-regular);
      white-space: nowrap;
    }

    .admin-table :is(th, .admin-chronology) {
      font-family: var(--font-data);
    }

    .admin-table :is(th:first-child, td:first-child:not([colspan])) {
      position: sticky;
      inset-inline-start: 0;
    }

    .admin-table td:first-child:not([colspan]) {
      /* Wrap long IDs without letting this column shrink to individual digits. */
      min-inline-size: min(25vw, 18ch);
      max-inline-size: 25vw;
      overflow-wrap: break-word;
      background: var(--color-lobby-surface);
    }

    .admin-table :is(td:nth-child(2), td:last-child:not([colspan])) {
      min-inline-size: 16ch;
      overflow-wrap: anywhere;
    }

    .actions a {
      padding-block: var(--space-1);
      color: var(--color-lobby-accent);
      text-decoration: underline;
    }

    :is(input, button, a, .admin-table-scroll):focus-visible {
      outline: var(--focus-width) solid var(--color-lobby-focus);
      outline-offset: var(--focus-offset);
    }
  }

  @media (forced-colors: active) {
    section :global(:is(input, button, a, .admin-table-scroll):focus-visible) {
      outline-color: Highlight;
    }
  }
</style>
