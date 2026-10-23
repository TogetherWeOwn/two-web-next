<script lang="ts">
import { page } from "$app/state";
import ErrorShell from "#lib/ErrorShell.svelte";
import Shell from "#lib/Shell.svelte";
import { FALLBACK_INVITE } from "../../../../src/invite";
import { isKitErrorStatus, kitErrorCopy } from "../../../../src/kit-errors";

// Route-level error page for GET /hotzones and /hotzones/:signal: a bad
// season answers its 400 with the season grammar plus the hotzone index and
// signal links, and an unknown signal answers its 404 with the signal list —
// the same in-context recovery the Hono twin renders. Within these routes a
// 400 is always the season grammar and a 404 is always the signal vocabulary,
// so the branches key on status alone; the thrown models stay plain strings,
// keeping data payloads machine-shaped. Any other failure (503, unexpected)
// keeps the shared shell with static copy, exactly as the root boundary.
const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);
const copy = $derived(kitErrorCopy(status));
const badSeason = $derived(page.status === 400);
const unknownSignal = $derived(page.status === 404);
const hotzoneRecovery = $derived(badSeason || unknownSignal);
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if hotzoneRecovery}
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
      {#if badSeason}
        <p class="lead">
          That season did not match. Use all for every season, a year like 2026, a month like
          2026-09, or a quarter like 2026-Q3.
        </p>
      {:else}
        <p class="lead">
          Unknown hot zone signal. The signals are joins, voice and games — pick one below, or
          browse every hot zone.
        </p>
      {/if}
      <p class="recovery-actions">
        <a class="btn" href="/hotzones" data-testid="error-hotzones">Browse all hot zones</a>
        <a href="/" data-testid="error-home">Back to the homepage</a>
      </p>
      <nav aria-label="Hot zone signals">
        <ul>
          <li><a href="/hotzones/joins" data-testid="error-hotzone-joins">Joins heatmap</a></li>
          <li><a href="/hotzones/voice" data-testid="error-hotzone-voice">Voice heatmap</a></li>
          <li><a href="/hotzones/games" data-testid="error-hotzone-games">Games heatmap</a></li>
        </ul>
      </nav>
    </section>
  </Shell>
{:else}
  <ErrorShell code={status} inviteUrl={FALLBACK_INVITE} />
{/if}
