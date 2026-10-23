<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";

// Markup contract of AdminDashboard (src/admin/pages/dashboard.tsx): the
// actor testid, the resource destinations, and the funnel/zero-search
// sections and testids are shared, so the existing admin E2E selectors
// still apply when this route owns traffic. Dates arrive pre-rendered as
// ISO strings from the load, exactly as the Hono page emits them.
let { data }: PageProps = $props();
const { actor, funnel, zeroSearches, retentionDays } = $derived(data);
const outcomes = $derived(funnel ? Object.entries(funnel) : []);
</script>

<AdminShell title="Dashboard">
<section aria-labelledby="admin-heading">
  <h1 id="admin-heading">Moderation</h1>
  <p class="lead">
    Signed in as <strong data-testid="admin-actor">{actor.username}</strong>.
  </p>
  <ul class="facts">
    <li class="card">
      <h2><a href="/admin/events">Events</a></h2>
      <p>Drafts, publishing, cancellations. Create-as-draft; events are never deleted.</p>
    </li>
    <li class="card">
      <h2><a href="/admin/featured">Featured content</a></h2>
      <p>Landing-page slots: publish toggle, ordering, show window.</p>
    </li>
    <li class="card">
      <h2><a href="/admin/activity-log">Activity log</a></h2>
      <p>Who changed what, when. Read-only; views that name a member are access-logged.</p>
    </li>
    <li class="card">
      <h2><a href="/admin/join-attempts">Join attempts</a></h2>
      <p>Every join try, outcome and refusal. Read-only.</p>
    </li>
  </ul>
  {#if funnel}
    <section data-testid="join-funnel" aria-labelledby="join-funnel-heading">
      <h2 id="join-funnel-heading">Join funnel, last {retentionDays} days</h2>
      {#if outcomes.length === 0}
        <p data-testid="join-funnel-empty">No join attempts in the window.</p>
      {:else}
        <p id="join-funnel-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the scroll region is intentionally keyboard-focusable so keyboard users can scroll the wide table on narrow screens (axe scrollable-region-focusable requires it); region pattern matches src/admin/pages/dashboard.tsx. -->
        <div
          class="admin-table-scroll"
          role="region"
          aria-label="Join funnel"
          aria-describedby="join-funnel-scroll-hint"
          tabindex="0"
          data-testid="join-funnel-table-scroll"
        >
          <table class="admin-table">
            <thead>
              <tr><th scope="col">Outcome</th><th scope="col">Attempts</th></tr>
            </thead>
            <tbody>
              {#each outcomes as [outcome, n] (outcome)}
                <tr>
                  <td>{outcome}</td>
                  <td data-testid={`funnel-${outcome}`}>{n}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
  {#if zeroSearches}
    <section data-testid="top-zero-searches" aria-labelledby="zero-searches-heading">
      <h2 id="zero-searches-heading">Top searches with no results</h2>
      <p>
        What guests looked for on /events and found nothing. A repeat miss is a game night
        nobody posted yet.
      </p>
      {#if zeroSearches.length === 0}
        <p data-testid="top-zero-searches-empty">No missed searches.</p>
      {:else}
        <p id="top-zero-searches-scroll-hint">Scroll horizontally to see all columns on smaller screens.</p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the scroll region is intentionally keyboard-focusable so keyboard users can scroll the wide table on narrow screens (axe scrollable-region-focusable requires it); region pattern matches src/admin/pages/dashboard.tsx. -->
        <div
          class="admin-table-scroll"
          role="region"
          aria-label="Top searches with no results"
          aria-describedby="top-zero-searches-scroll-hint"
          tabindex="0"
          data-testid="top-zero-searches-table-scroll"
        >
          <table class="admin-table">
            <thead>
              <tr><th scope="col">Search</th><th scope="col">Misses</th><th scope="col">Last searched</th></tr>
            </thead>
            <tbody>
              {#each zeroSearches as r (r.query)}
                <tr>
                  <td>{r.query}</td>
                  <td>{r.searches}</td>
                  <td>{r.lastSearchedAt}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</section>
</AdminShell>

<style>
  .admin-table-scroll:focus-visible {
    outline-color: currentColor;
  }
</style>
