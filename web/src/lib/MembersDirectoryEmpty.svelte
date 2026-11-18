<script lang="ts">
import Button from "./Button.svelte";
import type { MembersDirectoryView } from "./members-directory";

let {
  directory,
  clearSearchHref,
  everyoneHref,
}: {
  directory: Extract<MembersDirectoryView, { audience: "member" }>;
  clearSearchHref: string;
  everyoneHref: string;
} = $props();

const number = new Intl.NumberFormat("en");
const empty = $derived.by(() => {
  const { filterCounts, selection } = directory;
  if (selection.query) {
    const chars = [...selection.query];
    const term = chars.length > 32 ? `${chars.slice(0, 32).join("")}…` : selection.query;
    return {
      title: `Nobody matches "${term}".`,
      detail: "Try a Discord handle.",
      action: "Clear search",
      href: clearSearchHref,
    };
  }
  if (filterCounts.everyone === 0) {
    return {
      title: "No members to list yet.",
      detail: "Members show up here after they join from Discord.",
      action: "Find an event",
      href: "/events",
    };
  }
  return {
    title: selection.filter === "guides" ? "No Guides yet." : "No active members this month yet.",
    detail:
      selection.filter === "guides"
        ? "Guides help new members find their first event."
        : `Everyone lists all ${number.format(filterCounts.everyone)} members.`,
    action: "Show everyone",
    href: everyoneHref,
  };
});
</script>

<div class="members-empty">
  <div>
    <p class="empty-title">{empty.title}</p>
    <p class="empty-detail">{empty.detail}</p>
  </div>
  <Button size="sm" href={empty.href}>{empty.action}</Button>
</div>

<style>
  .members-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-5);
    border-radius: var(--radius-m);
    box-shadow: inset 0 0 0 1px var(--color-hair2);
    overflow-wrap: anywhere;
  }
  p { margin: 0; }
  .empty-title { color: var(--t1); font-size: var(--text-body); font-weight: var(--font-weight-semibold); }
  .empty-detail { color: var(--t2); font-size: var(--text-small); }
  @media (max-width: 820px) {
    .members-empty { flex-direction: column; align-items: flex-start; }
  }
  @media (forced-colors: active) {
    .members-empty { outline: 1px solid CanvasText; outline-offset: -1px; }
  }
</style>
