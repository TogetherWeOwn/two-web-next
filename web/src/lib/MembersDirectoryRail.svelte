<script lang="ts">
import MembersDirectoryAvatar from "./MembersDirectoryAvatar.svelte";
import TextLink from "./TextLink.svelte";
import type { MembersDirectoryView } from "./members-directory";

type Organizers = Extract<MembersDirectoryView, { audience: "member" }>["organizers"];
let { organizers, helpHref }: { organizers: Organizers; helpHref: string } = $props();
</script>

<aside aria-label="About the directory">
  {#if organizers.length}
    <section aria-labelledby="directory-organizers">
      <h2 id="directory-organizers">Who runs this</h2>
      <ul role="list">
        {#each organizers as organizer}
          <li>
            <MembersDirectoryAvatar name={organizer.name} src={organizer.avatarUrl} compact />
            <div><b>{organizer.name}</b><span>{organizer.role}</span></div>
          </li>
        {/each}
      </ul>
      <p class="directory-help">Questions or a problem with someone? Message any of them, or use <TextLink href={helpHref}>#help</TextLink>.</p>
    </section>
  {/if}
  <p class="directory-rule">Only signed-in members see names. Visitors see the counts.</p>
</aside>

<style>
  aside { align-self: start; overflow-wrap: anywhere; }
  section { padding: var(--two-space-inset-card); border: 1px solid var(--two-color-line-hairline); border-radius: var(--radius-l); background: var(--g1); }
  h2 { margin: 0 0 var(--space-3); font-size: var(--two-font-size-body-reading); font-weight: var(--font-weight-semibold); }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: var(--space-3); padding-block: var(--two-space-inset-tight); }
  li + li { border-block-start: 1px solid var(--two-color-line-hairline); }
  b, span { display: block; }
  b { font-size: var(--two-font-size-ui); }
  span { color: var(--t2); font-size: 13px; }
  .directory-help { color: var(--t2); font-size: var(--text-small); margin: var(--two-space-inset-room) 0 0; }
  .directory-help :global(a) { color: var(--ember); }
  .directory-rule { color: var(--t3); font: var(--text-label)/1.5 var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
</style>
