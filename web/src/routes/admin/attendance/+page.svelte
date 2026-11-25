<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
</script>

<AdminShell title="Event attendance">
  <section>
    <h1>Event attendance</h1>
    <p class="hint">Read-only preview with synthetic data.</p>
    <h2>{data.eventTitle}</h2>
    <p>
      Counting window<br />
      <time datetime={data.windowStart.iso ?? undefined}>{data.windowStart.label}</time>
      to <time datetime={data.windowEnd.iso ?? undefined}>{data.windowEnd.label}</time>
    </p>
    <p>{data.attendedCount} participants reached the {data.thresholdMinutes}-minute attendance threshold.</p>
    <table class="admin-table">
      <caption>Recorded participation</caption>
      <thead>
        <tr>
          <th scope="col">Participant</th>
          <th scope="col">Minutes</th>
          <th scope="col">Sessions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.rows as row (row.participant)}
          <tr>
            <th scope="row">{row.participant}</th>
            <td>{row.minutes}</td>
            <td>{row.sessions}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</AdminShell>

<style>
  section {
    border-color: var(--color-hair2);
    padding-block: var(--space-6);
    font: var(--text-small) / var(--leading-body) var(--font-ui);
  }

  h1 {
    margin-block: 0 var(--space-3);
    font: var(--font-weight-display) var(--text-h3) / var(--leading-heading) var(--font-display);
    letter-spacing: var(--tracking-h3);
  }

  caption {
    text-align: start;
    padding-block-end: var(--space-2);
    font-weight: var(--font-weight-semibold);
  }

  time, td {
    font-family: var(--font-data);
  }

  .admin-table :is(th, td) {
    padding: var(--space-2);
    border-color: var(--color-hair2);
  }

  thead th {
    background: var(--color-lobby-raised);
  }

  tbody th {
    font-weight: var(--font-weight-regular);
  }
</style>
