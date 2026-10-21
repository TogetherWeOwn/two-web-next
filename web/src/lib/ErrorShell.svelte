<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { kitErrorCopy, type KitErrorStatus } from "../../../src/kit-errors";

let {
  code,
  inviteUrl,
}: {
  code: KitErrorStatus;
  inviteUrl: string;
} = $props();

const copy = $derived(kitErrorCopy(code));

// Outage headers point at the Discord invite, never the OAuth start:
// during a store outage or throttle the sign-in round trip is dead, so the
// header carries Hono's cta-branch contract instead (src/page-shell.tsx:
// guest caption plus an invite "Open Discord" link on data-testid="signin").
// 400/404/410 keep the default sign-in header — OAuth is alive there.
const OUTAGE_CODES: KitErrorStatus[] = [403, 429, 500, 503];
const isOutage = $derived(OUTAGE_CODES.includes(code));
</script>

{#snippet outageAccount()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href={inviteUrl} data-testid="signin">Open Discord</a>
  </div>
{/snippet}

<Shell
  title={copy.title}
  robots="noindex, nofollow"
  theme="home"
  accountChrome={isOutage ? outageAccount : undefined}
>
  <section class="hero recovery-hero" aria-labelledby="error-heading">
    <div class="hero-detail hero-detail-left" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <div class="hero-detail hero-detail-right" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <p class="recovery-code" aria-hidden="true">{copy.code}</p>
    <h1 id="error-heading">{copy.title}</h1>
    <p class="lead">{copy.lead}</p>
    {#if code === 404}
      <!-- 404 -->
      <p class="recovery-actions">
        <a class="btn" href="/auth/discord" data-testid="error-join">Join with Discord</a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
      <p><a href="/events" data-testid="error-all-events">Browse all events</a></p>
    {:else if code === 400 || code === 410}
      <!-- 400/410 share recovery links; each keeps its status-specific copy. -->
      <p class="recovery-actions">
        <a class="btn" href="/events" data-testid="error-events">Browse all events</a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else if code === 403}
      <!-- 403 names the join-to-unlock path; re-signing in cannot mint the member bit. -->
      <p class="recovery-actions">
        <a class="btn" href="/join" data-testid="error-join-unlock">Join to unlock member pages</a>
        <a href={inviteUrl} data-testid="error-invite" rel="noopener">
          Use the Discord invite instead
        </a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else if code === 429 || code === 500}
      <!-- These statuses share invite recovery, not their headings or lead copy. -->
      <p class="recovery-actions">
        <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
          Use the Discord invite instead
        </a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else}
      <!-- 503: We will be right back -->
      <p class="recovery-actions">
        <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
          Use the Discord invite instead
        </a>
        <a href="/" data-testid="error-retry">Try again</a>
      </p>
    {/if}
  </section>
  {#if code === 404}
    <!-- Generic-404 search: markup twin of Hono's NotFoundPage and
      EventMissing (same action, input contract and submit button). Its own
      section, not the hero: the rendered-a11y suite pins the hero's exact
      text and the page's single heading. Suggestions stay out of scope —
      the boundary reads no database — so there is no "Happening soon" twin. -->
    <section class="recovery-events">
      <form action="/events" method="get" role="search" class="error-events-search">
        <label for="error-events-search">Search events</label>
        <div>
          <input
            id="error-events-search"
            name="q"
            type="search"
            placeholder="Search events…"
            autocomplete="off"
            data-testid="error-events-search"
          />
          <button type="submit" class="btn" data-testid="error-events-search-submit">
            Search events
          </button>
        </div>
      </form>
    </section>
  {/if}
</Shell>
