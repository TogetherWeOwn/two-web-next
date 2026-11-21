<script lang="ts">
import EmberShell from "#lib/EmberShell.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
import type { RecoveryModel } from "../../../src/recovery-outcome";

// Keep the Hono recovery heading, lead, retry and invite markup contracts.
// The server supplies display copy and validated destinations; never render
// raw provider input. The type-only import adds no Hono code to the Kit worker.
let { title, message, retryUrl, retryLabel, inviteUrl, supportReference }: RecoveryModel = $props();
</script>

{#snippet guestChrome()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href="/join" data-testid="signin">Join with Discord</a>
  </div>
{/snippet}

<SiteMetadata title={title} theme="home" />
<EmberShell accountChrome={guestChrome} hideJoin menuFallbackOnly>
  <section class="hero recovery-hero" aria-labelledby="recovery-heading">
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
    <p class="strap">Let's get you back to the lobby</p>
    <h1 id="recovery-heading">{title}</h1>
    <p class="lead">{message}</p>
    <p class="recovery-actions">
      <a class="btn" href={retryUrl} data-testid="recovery-retry">{retryLabel}</a>
      {" "}<a href={inviteUrl} data-testid="recovery-invite">Join with an invite link instead</a>
    </p>
    {#if supportReference}
      <p class="support-reference">
        Support reference: <code data-testid="error-support-reference">{supportReference}</code>
      </p>
    {/if}
  </section>
</EmberShell>
