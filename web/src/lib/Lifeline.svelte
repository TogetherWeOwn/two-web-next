<script lang="ts">
import type { LifelineStep } from "./lifeline";
import { structuredTime } from "./structured-time";

let { steps, zone }: { steps: readonly LifelineStep[]; zone?: string } = $props();
const headingId = $props.id();
const current = $derived(
  steps.find((step) => step.state === "current") ?? steps.find((step) => step.state === "next"),
);
const labels = {
  recorded: "Recorded",
  current: "Counting now",
  next: "Next",
  planned: "Planned",
  waiting: "Waiting",
};
</script>

<section aria-labelledby={headingId}>
  <h2 id={headingId}>Lifeline</h2>
  <p class="gloss">What the bot has done, and will do</p>
  <ol role="list">
    {#each steps as step (step.id)}
      {@const time = step.at === undefined ? null : structuredTime(new Date(step.at), zone)}
      <li data-state={step.state} aria-current={step === current ? "step" : undefined}>
        {#if time}
          <time datetime={time.datetime}>{time.localTime} {time.zone} <span>{time.localDate}</span></time>
        {/if}
        <span class="track" aria-hidden="true">
          <span class="marker">
            {#if step.state === "recorded"}<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 8 3 3 7-7" /></svg>{/if}
          </span>
        </span>
        <div class="entry">
          <p class="meta" class:bot={step.actor === "Bot"}>{step.actor} · {labels[step.state]}</p>
          <p class="title">{step.title}</p>
          {#if step.detail}<p class="detail">{step.detail}</p>{/if}
        </div>
      </li>
    {/each}
  </ol>
</section>

<style>
  section { color: var(--t1); font: var(--text-body)/var(--leading-body) var(--font-ui); }
  h2, p { margin: 0; }
  h2 {
    font: var(--font-weight-display) var(--text-h2)/var(--leading-heading) var(--font-display);
    letter-spacing: var(--tracking-h2);
  }
  .gloss, time, .meta {
    color: var(--t3);
    font: var(--text-label)/var(--leading-label) var(--font-data);
    letter-spacing: var(--tracking-label);
  }
  .gloss, .meta { text-transform: uppercase; }
  .gloss { margin-block: var(--space-2) var(--space-5); }
  ol { padding: 0; margin: 0; list-style: none; }
  li {
    display: grid;
    grid-template-columns: 118px 28px minmax(0, 1fr);
    column-gap: var(--space-inset-room);
  }
  time { grid-column: 1; grid-row: 1; text-align: end; overflow-wrap: anywhere; }
  time span { display: block; }
  .track { grid-column: 2; grid-row: 1; position: relative; }
  li:not(:last-child) .track::before {
    content: ""; position: absolute; inset: 0 auto 0 calc(50% - 1px);
    border-inline-start: 2px solid var(--color-hair2);
  }
  .marker {
    position: relative; display: grid; place-items: center; box-sizing: border-box;
    width: 28px; height: 28px; border: 2px solid var(--color-hair2);
    border-radius: var(--radius-pill); background: var(--g0); color: var(--t2);
  }
  [data-state="recorded"] .marker { background: var(--g3); border-color: var(--g3); }
  [data-state="recorded"] .title { color: var(--t2); }
  [data-state="next"] .marker, [data-state="current"] .marker { border-color: var(--ember); }
  [data-state="next"] .marker::after, [data-state="current"] .marker::after {
    content: ""; width: 10px; height: 10px; border-radius: var(--radius-pill); background: var(--ember);
  }
  .entry { grid-column: 3; grid-row: 1; padding-block-end: var(--space-4); overflow-wrap: anywhere; }
  .meta::before {
    content: ""; display: inline-block; box-sizing: border-box; width: var(--space-2); height: var(--space-2);
    margin-inline-end: var(--space-2); border: 1px solid var(--ember); border-radius: var(--radius-pill);
  }
  .bot::before { border: 0; border-radius: var(--radius-s); background: var(--gradient-brand); }
  .title { font-weight: var(--font-weight-semibold); }
  .detail { color: var(--t2); font-size: var(--text-ui); }
  @media (max-width: 820px) {
    li { grid-template-columns: 28px minmax(0, 1fr); }
    .track { grid-column: 1; grid-row: 1 / span 2; }
    time { grid-column: 2; text-align: start; margin-block-end: var(--space-1); }
    time span { display: inline; }
    .entry { grid-column: 2; grid-row: 2; }
  }
</style>
