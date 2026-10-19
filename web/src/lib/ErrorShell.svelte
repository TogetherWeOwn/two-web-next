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
const title = $derived(copy.title);
</script>

<Shell {title} robots="noindex, nofollow" theme="home">
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
    {#if code === 400}
      <!-- 400: We could not read that request -->
      <p class="recovery-actions">
        <a class="btn" href="/events" data-testid="error-events">Browse all events</a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else if code === 404}
      <!-- 404 -->
      <p class="recovery-actions">
        <a class="btn" href="/auth/discord" data-testid="error-join">Join with Discord</a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
      <p><a href="/events" data-testid="error-all-events">Browse all events</a></p>
    {:else if code === 403}
      <!-- 403: You do not have access -->
      <p class="recovery-actions">
        <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
          Use the Discord invite instead
        </a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else if code === 410}
      <!-- 410: This page is gone -->
      <p class="recovery-actions">
        <a class="btn" href="/events" data-testid="error-events">Browse all events</a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else if code === 429}
      <!-- 429: Slow down a little -->
      <p class="recovery-actions">
        <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
          Use the Discord invite instead
        </a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
    {:else if code === 500}
      <!-- 500: Something broke on our side -->
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
</Shell>
