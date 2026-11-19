<script lang="ts">
// Adapted from the reconciliation screens in PR #2033 by Rick7C2.
import AdminShell from "#lib/AdminShell.svelte";
import { resolutionLabel } from "./labels";
import type { PageProps } from "./$types";
let { data }: PageProps = $props();
</script>

<AdminShell title="Reconciliation">
  <p><a href="/admin">Back to the dashboard</a></p>
  <h1>Reconciliation</h1>
  <p>
    This read-only view shows recorded reconciliation intents only. Some unconfirmed bot
    changes may not appear here. Check Discord independently before drawing a conclusion
    about delivery.
  </p>
  {#each [false, true] as resolved (resolved)}
    {@const id = resolved ? "reconciliation-resolved" : "reconciliation-open"}
    {@const records = resolved ? data.resolved : data.open}
    <h2 {id}>{resolved ? "Recently resolved" : "Open intents"}</h2>
    {#if records.length}
      <div class="admin-table-scroll" role="region" aria-labelledby={id} tabindex="0">
        <table class="admin-table">
          <thead><tr>
            <th scope="col">Change</th>
            <th scope="col">{resolved ? "Resolved (UTC)" : "First recorded (UTC)"}</th>
            <th scope="col">Subject</th>
            <th scope="col">{resolved ? "Resolution" : "Last outcome"}</th>
          </tr></thead>
          <tbody>
            {#each records as row (row.idempotencyKey)}
              {@const iso = (row.resolvedAt ?? row.firstSeenAt).toISOString()}
              <tr>
                <td><a href={`/admin/reconciliation/${encodeURIComponent(row.idempotencyKey)}`}>
                  {row.verb}<span class="sr-only">: {row.idempotencyKey}</span>
                </a></td>
                <td class="admin-chronology"><time datetime={iso}>{iso.slice(0, 19).replace("T", " ")}</time></td>
                <td>{row.subject ?? "—"}</td>
                <td>{resolved ? resolutionLabel(row.resolution) : (row.lastCode ?? "—")}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p>No {resolved ? "resolved" : "open"} intents recorded.</p>
    {/if}
  {/each}
</AdminShell>
