<script lang="ts">
let { name, src, compact = false }: { name: string; src?: string; compact?: boolean } = $props();
let failedSrc = $state<string>();
let initials = $derived([...name].slice(0, 2).join("").toUpperCase());
let color = $derived(
  [...name].reduce((hash, char) => (31 * hash + (char.codePointAt(0) ?? 0)) % 12, 0),
);
</script>

<span class="directory-avatar" class:compact data-tone={color} aria-hidden="true">
  {initials}
  {#if src && src !== failedSrc}
    <img {src} alt="" loading="lazy" onerror={() => { failedSrc = src; }} />
  {/if}
</span>

<style>
  .directory-avatar {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    inline-size: var(--two-size-avatar-lg);
    block-size: var(--two-size-avatar-lg);
    border-radius: var(--two-radius-pill);
    overflow: hidden;
    color: var(--two-color-avatar-text);
    font: var(--font-weight-semibold) var(--text-label)/1 var(--font-ui);
  }
  [data-tone="0"] { background-color: var(--two-color-avatar-0); }
  [data-tone="1"] { background-color: var(--two-color-avatar-1); }
  [data-tone="2"] { background-color: var(--two-color-avatar-2); }
  [data-tone="3"] { background-color: var(--two-color-avatar-3); }
  [data-tone="4"] { background-color: var(--two-color-avatar-4); }
  [data-tone="5"] { background-color: var(--two-color-avatar-5); }
  [data-tone="6"] { background-color: var(--two-color-avatar-6); }
  [data-tone="7"] { background-color: var(--two-color-avatar-7); }
  [data-tone="8"] { background-color: var(--two-color-avatar-8); }
  [data-tone="9"] { background-color: var(--two-color-avatar-9); }
  [data-tone="10"] { background-color: var(--two-color-avatar-10); }
  [data-tone="11"] { background-color: var(--two-color-avatar-11); }
  .compact { inline-size: var(--two-size-avatar-md); block-size: var(--two-size-avatar-md); }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  @media (forced-colors: active) { .directory-avatar { border: 1px solid CanvasText; } }
</style>
