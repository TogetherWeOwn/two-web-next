<script lang="ts">
import Button from "./Button.svelte";
import Tag from "./Tag.svelte";

// This preview deliberately has no Echo data shape or live reader.
type Entry = { day: string; date: string; title: string; detail: string; kind: "Guide" | "Joined" };
type Preview =
  | { kind: "record" | "withheld"; entries: readonly [Entry, ...Entry[]] }
  | { kind: "new" };
let { preview }: { preview: Preview } = $props();
</script>

{#if preview.kind === "record"}
  <section aria-labelledby="echo-trail-heading">
    <h2 id="echo-trail-heading">Echo trail</h2>
    <p>Layout preview only. No Echo observations are shown.</p>
  </section>
{/if}
{#if preview.kind !== "new"}
  <section aria-labelledby="record-heading">
    <h2 id="record-heading">Record</h2>
    <ol role="list">
      {#each preview.entries as entry}
        <li>
          <time datetime={entry.day}>{entry.date}</time>
          <span class="mark" class:granted={entry.kind === "Guide"} aria-hidden="true"></span>
          <div><strong>{entry.title}</strong><p>{entry.detail}</p></div>
          <Tag>{entry.kind}</Tag>
        </li>
      {/each}
    </ol>
  </section>
{:else}
  <section aria-labelledby="record-heading">
    <h2 id="record-heading">Record</h2>
    <div class="empty">
      <strong>Your record starts with your first event.</strong>
      <Button size="sm" href="/events">Find an event</Button>
    </div>
  </section>
{/if}

<style>
  section { margin-block: var(--space-6); }
  section > h2 {
    margin: 0 0 var(--space-3);
    font: var(--font-weight-display) var(--text-h3)/var(--leading-heading) var(--font-display);
    font-stretch: var(--font-width-display);
    letter-spacing: var(--tracking-h3);
    text-transform: none;
  }
  ol, p { margin: 0; }
  ol { padding: 0; list-style: none; }
  li {
    display: grid; grid-template-columns: 7rem auto minmax(0, 1fr) auto;
    gap: var(--space-2) var(--space-3); align-items: baseline;
    padding-block: var(--space-4); border-top: 1px solid var(--color-hair2);
  }
  time { color: var(--color-t3); font: var(--text-label)/var(--leading-label) var(--font-data); }
  strong { font-size: var(--text-body); font-weight: var(--font-weight-semibold); }
  p { color: var(--color-t2); font-size: var(--text-small); }
  .mark { width: var(--space-2); height: var(--space-2); background: currentColor; border-radius: var(--radius-s); }
  .granted { background: var(--gradient-brand); border-radius: 0; }
  .empty {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    padding: var(--space-5); border-radius: var(--radius-m); border: 1px solid var(--color-hair2);
  }
  @media (max-width: 820px) {
    li { grid-template-columns: auto minmax(0, 1fr) auto; }
    time { grid-column: 1 / -1; }
    .empty { flex-direction: column; align-items: flex-start; }
  }
</style>
