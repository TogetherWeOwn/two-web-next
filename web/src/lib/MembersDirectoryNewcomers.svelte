<script lang="ts">
import Button from "./Button.svelte";
import MembersDirectoryAvatar from "./MembersDirectoryAvatar.svelte";
import type { MembersDirectoryView } from "./members-directory";

type Newcomers = Extract<MembersDirectoryView, { audience: "member" }>["newcomers"];
let { newcomers }: { newcomers: Newcomers } = $props();
</script>

{#if newcomers.length}
  <section aria-labelledby="directory-newcomers">
    <h2 id="directory-newcomers">Joined this week</h2>
    <ul role="list">
      {#each newcomers as newcomer}
        <li>
          <MembersDirectoryAvatar name={newcomer.name} src={newcomer.avatarUrl} />
          <b>{newcomer.name}</b>
          <span>{newcomer.day}</span>
          <Button size="sm" href={newcomer.sayHiHref} ariaLabel={`Say hi to ${newcomer.name}`}>Say hi</Button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  h2, span {
    color: var(--t3);
    font: var(--text-label)/1.3 var(--font-data);
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
  }
  h2 { margin: 0 0 var(--space-2); }
  ul {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: var(--space-3);
    padding: 0;
    margin: 0 0 48px;
    list-style: none;
  }
  li {
    display: grid;
    justify-items: center;
    gap: var(--space-2);
    padding: var(--two-space-inset-compact) var(--two-space-inset-room);
    border: 1px solid var(--two-color-line-hairline);
    border-radius: var(--radius-l);
    background: var(--g1);
    color: var(--t1);
    font-size: var(--two-font-size-ui);
    text-align: center;
    overflow-wrap: anywhere;
  }
  @media (max-width: 820px) {
    ul {
      grid-template-columns: none;
      grid-auto-flow: column;
      grid-auto-columns: 140px;
      overflow-x: auto;
      margin: 0 calc(-1 * var(--two-layout-gutter-compact)) var(--space-7);
      padding: 0 var(--two-layout-gutter-compact) var(--space-2);
    }
  }
</style>
