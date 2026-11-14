<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of Join (src/screens/join.tsx): test ids, links, copy and
// the click-to-load widget facade are shared, so the existing E2E and island
// apply. The banner and intro sentences arrive as load data from the shared
// plain-TS copy module (never imported from the .tsx): importing the Hono
// screen would bundle the JSX runtime into the Kit worker.
// A component-level <script> is Svelte's own; the island tag is emitted as markup.
let { data }: PageProps = $props();
// The server load builds /join/discord from the sanitized query inputs.
const { inviteUrl, widgetUrl, widgetSnapshot, oneClickHref, appUrl, joinResult, notice } =
  $derived(data);
const { HOME_JOIN_RESULT_COPY, JOIN_INTRO } = $derived(data.joinCopy);
// The island binder is a plain script tag, not hydration: with csr=false the
// no-JS contract (links, presence or fallback copy in the raw fetch body) holds.
const island = '<script src="/islands/join-widget.js" defer></' + "script>";
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/join.md" />
</svelte:head>

{#snippet accountChrome()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href="/auth/discord" data-testid="signin">Sign in with Discord</a>
  </div>
{/snippet}

<Shell
  restoredWrite={data.restoredWrite}
  title="Join Together We Own"
  canonical={canonicalUrl(appUrl, "/join")}
  description={JOIN_INTRO}
  theme="join"
  {accountChrome}
>
  {#if joinResult}
    <p class="notice" role="status" data-testid="join-result">
      {#if joinResult === "added"}
        {HOME_JOIN_RESULT_COPY.added}
      {:else}
        {HOME_JOIN_RESULT_COPY.alreadyInServer}{" "}
        <a href="/discord" data-testid="reinvite-link">{HOME_JOIN_RESULT_COPY.reinvite}</a>
      {/if}
    </p>
  {/if}
  {#if notice}
    <!-- Already allowlisted by the load (start-failed or null). Display-only:
      explains a failed start, never echoed into the one-click href. Copy is
      byte-identical to the Hono banner (src/screens/join.tsx). -->
    <p class="notice" role="status" data-testid="join-start-notice">
      The Discord approval failed to start — try again below.
    </p>
  {/if}
  <div class="ember-join">
    <div class="join-identity">
      <img src="/icons/icon-192.png" alt="" />
      <div><strong>Together We Own</strong><p>A Discord gaming community · founded 1998 · English</p></div>
    </div>
    <h1 id="join-heading">Play with people <em>who show up.</em></h1>
    <p class="join-lede">{JOIN_INTRO}</p>
    <aside class="join-card" aria-labelledby="join-card-heading">
      <h2 id="join-card-heading">Join with one sign-in</h2>
      <a class="btn join-primary" href={oneClickHref} data-testid="join-oneclick">Join with Discord</a>
      <p>Already in our server? The same button signs you in.</p>
      <a href={inviteUrl} data-testid="join-invite">Join with an invite link instead</a>
      <div class="join-privacy">
        <p>We never post as you or read your messages.</p>
        <p>Leave any time. Ask a moderator and we delete your data. <a href="/privacy">How deletion works</a></p>
      </div>
    </aside>
    <section class="join-steps" aria-labelledby="join-steps-heading">
      <h2 class="join-visually-hidden" id="join-steps-heading">What happens when you join</h2>
      <ol role="list">
        <li><span aria-hidden="true">01</span><div><h3>Discord asks you to say yes</h3><p>We ask for your name, your avatar and permission to add you to our server. Nothing else.</p></div></li>
        <li><span aria-hidden="true">02</span><div><h3>The bot lets you in and makes you a Prospect</h3><p>It takes a few seconds. Then finish Discord's rules screening and you can post.</p></div></li>
        <li><span aria-hidden="true">03</span><div><h3>You land back here, signed in</h3><p>Pick an event and say you're in. Show up a few times and you become a Member.</p></div></li>
      </ol>
    </section>
    <section class="join-norms" aria-labelledby="join-norms-heading">
      <h2 id="join-norms-heading">What we ask of you</h2>
      <ul role="list">
        <li>Be kind on voice. Newcomers get patience, not tests.</li>
        <li>If you said you're in, come, or drop out before it starts.</li>
        <li>You must be 18 or older. <a href="/rules">Read the full rules</a></li>
      </ul>
    </section>
    <div class="join-preview">
      {#if widgetSnapshot}
        <section aria-labelledby="discord-presence-heading" data-testid="join-widget-presence">
          <h2 id="discord-presence-heading">In {widgetSnapshot.name} now</h2>
          <p data-testid="join-widget-online">
            <strong>{widgetSnapshot.presenceCount}</strong>{" "}
            {widgetSnapshot.presenceCount === 1 ? "member online" : "members online"}
          </p>
          <p>
            <a href={widgetSnapshot.inviteUrl ?? inviteUrl} data-testid="join-widget-invite">
              Join with an invite link
            </a>
          </p>
          {#if widgetSnapshot.channels.length > 0}
            <h3>Voice and stage channels</h3>
            <ul data-testid="join-widget-channels">
              {#each widgetSnapshot.channels as channel (channel.id)}<li>{channel.name}</li>{/each}
            </ul>
          {:else}
            <p>No voice channels open right now.</p>
          {/if}
          <!-- Public page: aggregate presence only (count + channels). The load
            projects the snapshot before returning, so member names never reach
            __data.json on this logged-out, indexed page (privacy policy v2). -->
        </section>
        {#if widgetUrl}
          <div class="strap">
            <p>Discord's live server preview loads only when you ask for it.</p>
            <a
              class="btn"
              href={widgetUrl}
              referrerpolicy="no-referrer"
              data-join-widget
              data-testid="join-widget-load"
            >
              Show live server preview
            </a>
            {@html island}
          </div>
        {/if}
      {:else if widgetUrl}
        <div class="strap">
          <p>Discord's live server preview loads only when you ask for it.</p>
          <a
            class="btn"
            href={widgetUrl}
            referrerpolicy="no-referrer"
            data-join-widget
            data-testid="join-widget-load"
          >
            Show live server preview
          </a>
          {@html island}
        </div>
      {:else}
        <p class="strap" data-testid="join-widget-fallback">
          Live server preview is unavailable — the join button above still works.
        </p>
      {/if}
    </div>
  </div>
</Shell>

<style>
  .ember-join {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 420px;
    column-gap: var(--space-8);
    align-items: start;
    margin-block: var(--space-8);
  }
  .ember-join > :not(.join-card) { grid-column: 1; min-width: 0; }
  .ember-join :is(h1, h2, h3) { text-transform: none; }
  .join-steps, .join-norms { padding: 0; }
  .join-identity { display: flex; align-items: center; gap: var(--space-3); }
  .join-identity img { width: var(--space-8); height: var(--space-8); border-radius: var(--radius-s); }
  .join-identity p { margin: 0; font: var(--text-label) / var(--leading-label) var(--font-data); color: var(--t3); }
  .ember-join h1 { margin: var(--space-6) 0; font: var(--font-weight-display) var(--text-hero) / var(--leading-display) var(--font-display); letter-spacing: var(--tracking-display); }
  .ember-join h1 em { font-family: var(--font-accent); font-weight: var(--font-weight-regular); }
  .join-lede { font-size: var(--text-lede); color: var(--t2); }
  .join-card { grid-column: 2; grid-row: 1 / span 6; position: sticky; top: var(--space-11); padding: var(--space-inset-card-lg); background: var(--g1); border: 1px solid var(--color-hair2); border-radius: var(--radius-l); }
  .join-card h2 { margin-top: 0; }
  .join-primary { display: block; width: 100%; text-align: center; }
  .join-privacy { border-top: 1px solid var(--color-hair2); margin-top: var(--space-6); padding-top: var(--space-4); }
  .join-card p, .join-steps p { color: var(--t2); }
  .join-steps, .join-norms, .join-preview { margin-top: var(--space-7); }
  .join-steps ol, .join-norms ul { list-style: none; padding: 0; }
  .join-steps li { display: flex; gap: var(--space-4); margin-bottom: var(--space-5); }
  .join-steps li > span { color: var(--t3); font-family: var(--font-data); }
  .join-steps h3, .join-steps p { margin: 0; }
  .join-norms li { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
  .join-norms li::before { content: '✓'; color: var(--ok); }
  .join-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  @media (max-width: 820px) {
    .ember-join { display: block; }
    .join-card { position: static; padding: var(--space-inset-card); margin-top: var(--space-7); }
  }
</style>
