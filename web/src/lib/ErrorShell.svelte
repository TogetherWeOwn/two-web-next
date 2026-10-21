<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { kitErrorCopy, type KitErrorStatus } from "../../../src/kit-errors";

let {
  code,
  inviteUrl,
  supportReference,
}: {
  code: KitErrorStatus;
  inviteUrl: string;
  // Validated request id from page data. Optional: without one the shell
  // omits the reference block blank-safe, exactly as before.
  supportReference?: string;
} = $props();

const copy = $derived(kitErrorCopy(code));
</script>

<Shell title={copy.title} robots="noindex, nofollow" theme="home">
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
    {#if supportReference}
      <!-- Hono SupportReference conventions (src/error-pages.tsx): the same
        paragraph class, visible copy and code testid, so the moderator
        guide's "use the response's support reference" holds on Kit pages. -->
      <p class="support-reference">
        Support reference: <code data-testid="error-support-reference">{supportReference}</code>
      </p>
    {/if}
  </section>
</Shell>
