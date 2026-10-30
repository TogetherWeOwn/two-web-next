<script lang="ts">
import AdminShell, { searchNotice } from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";

// Markup contract of JoinAttemptsPage (src/admin/pages/join-attempts.tsx):
// the lookup field ids, the scroll region and result-list testids, the five
// scoped columns, the empty testid, the detail hrefs and the paging nav are
// shared, so the existing admin E2E selectors still apply when this route owns
// traffic. Dates arrive pre-rendered as ISO strings from the load, exactly
// as the Hono page emits them. Search stays an exact Discord/request-id
// match owned by the shared read — no substring scan, no new grammar here.
// (Wording here avoids bare Tailwind utility names: the v4 scanner lifts
// candidates from Svelte sources and would otherwise emit unused rules for
// any it finds into the client stylesheet.)
// No <script> island: the Hono viewer ships no JavaScript, so this page
// carries none either (csr=false comes from the admin group layout).
let { data }: PageProps = $props();
const query = $derived(data.query);
const outcomes = $derived(
  query.outcome !== "" && !data.outcomes.includes(query.outcome)
    ? [...data.outcomes, query.outcome]
    : data.outcomes,
);
</script>

<AdminShell title="Join attempts">
<section aria-labelledby="join-attempts-heading">
  <h1 id="join-attempts-heading">Join attempts</h1>
  <p class="hint">
    Read-only. Last {data.retentionDays} days, newest first. Search is an exact Discord id or request id.
  </p>
  <form method="get" action="/admin/join-attempts" class="filters">
    <div class="field">
      <label for="q">Discord id or request id</label>
      <input id="q" name="q" type="search" value={query.q} />
    </div>
    <div class="field">
      <label for="outcome">Outcome</label>
      <select id="outcome" name="outcome">
        {#each ["", ...outcomes] as o (o)}
          <option value={o} selected={o === query.outcome}>{o === "" ? "All" : o}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <button type="submit" class="btn">Filter</button>
    </div>
  </form>
  {@render searchNotice(query)}
  <p id="join-attempts-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: the labelled scroll region stays keyboard-focusable exactly like the Hono viewer (axe scrollable-region-focusable requires a focusable scroller); role="region" names it, tabindex={0} reaches it. -->
  <div
    class="admin-table-scroll"
    role="region"
    aria-label="Join attempts list"
    aria-describedby="join-attempts-scroll-hint"
    tabindex={0}
    data-testid="join-attempts-table-scroll"
  >
    <table class="admin-table" data-testid="join-attempts-table">
      <thead>
        <tr>
          <th scope="col">Outcome</th>
          <th scope="col">Source</th>
          <th scope="col">Discord id</th>
          <th scope="col">Request id</th>
          <th scope="col">Attempted (UTC)</th>
        </tr>
      </thead>
      <tbody>
        {#each data.rows as r (r.id)}
          <tr>
            <td>
              <a
                href={`/admin/join-attempts/${r.id}`}
                aria-label={`View join attempt ${r.id}: ${r.outcome}`}>{r.outcome}</a
              >
            </td>
            <td>{r.source ?? ""}</td>
            <td>{r.discordId ?? ""}</td>
            <td>{r.requestId ?? ""}</td>
            <td>{r.createdAt}</td>
          </tr>
        {:else}
          <tr>
            <td colspan={5} data-testid="join-attempts-empty">No join attempts.</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <nav aria-label="Join attempt pages" class="actions">
    {#if data.prevUrl}
      <a rel="prev" href={data.prevUrl}>Previous</a>
    {/if}
    <span>Page {query.page}</span>
    {#if data.hasNext && data.nextUrl}
      <a rel="next" href={data.nextUrl}>Next</a>
    {/if}
  </nav>
</section>
</AdminShell>
