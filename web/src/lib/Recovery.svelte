<script lang="ts">
import Shell from "#lib/Shell.svelte";

// Shared recovery shell: the Svelte adapter over the RecoveryModel shape
// (src/recovery-outcome.ts). Markup contract of Recovery
// (src/screens/recovery.tsx over src/page-shell.tsx RecoveryShell): hero
// chrome, heading id, lead message, retry button and invite fallback keep
// their classes, testids and copy on every renderer, so the existing recovery
// tests and the no-JS contract still apply. Copy is duplicated here
// deliberately (never imported from the .tsx): importing the Hono screen
// would bundle the JSX runtime into the Kit worker. All values are display
// copy or safe same-origin destinations built server-side — never echoed
// OAuth input — so no raw-HTML rendering is needed and Svelte's default escaping holds.
let {
  title,
  message,
  retryUrl,
  retryLabel,
  inviteUrl,
}: {
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
} = $props();
</script>

{#snippet guestChrome()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href="/join" data-testid="signin">Join with Discord</a>
  </div>
{/snippet}

<Shell title={title} theme="home" accountChrome={guestChrome}>
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
  </section>
</Shell>
