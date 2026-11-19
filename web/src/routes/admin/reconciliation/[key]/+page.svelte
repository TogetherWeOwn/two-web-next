<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import { resolutionLabel } from "../labels";
import type { PageProps } from "./$types";
let { data }: PageProps = $props();
const row = $derived(data.row);
</script>

<AdminShell title="Reconciliation detail">
  <section aria-labelledby="reconciliation-heading">
    <p><a href="/admin/reconciliation" class="reconciliation-focus">Back to reconciliation</a></p>
    <h1 id="reconciliation-heading">{row.verb}</h1>
    {#if !row.resolvedAt}
      <p class="notice">
        Delivery was not confirmed. Check Discord independently. This page is read-only.
      </p>
    {/if}
    <dl>
      <dt>Status</dt><dd>{row.resolvedAt ? "Resolved" : "Open"}</dd>
      <dt>Intent key</dt><dd>{row.idempotencyKey}</dd>
      <dt>Subject</dt><dd>{row.subject ?? "—"}</dd>
      <dt>Attempts</dt><dd>{row.attempts}</dd>
      <dt>Last outcome</dt><dd>{row.lastCode ?? "—"}</dd>
      <dt>Last HTTP status</dt><dd>{row.lastStatus ?? "—"}</dd>
      {#each [["First recorded", row.firstSeenAt], ["Last attempt", row.lastAttemptAt], ["Resolved", row.resolvedAt]] as [label, date] (label)}
        {#if date instanceof Date}
          {@const iso = date.toISOString()}
          <dt>{label} (UTC)</dt><dd><time datetime={iso}>{iso.slice(0, 19).replace("T", " ")}</time></dd>
        {/if}
      {/each}
      {#if row.resolvedAt}
        <dt>Recorded resolution</dt><dd>{resolutionLabel(row.resolution)}</dd>
      {/if}
    </dl>
    {#if row.resolvedAt}
      <p class="hint">Read-only. Resolved keys stay as audit evidence.</p>
    {/if}
  </section>
</AdminShell>

<style>
  h1, dd { overflow-wrap: break-word; }
</style>
