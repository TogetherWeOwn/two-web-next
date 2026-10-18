<script lang="ts">
// The content theme renders leaf-CSS classes only (Hono parity): the served
// content leaf carries no layout stylesheet (transformContentLeafChunk strips
// it), so Tailwind utilities would arrive unstyled. The leaf block's
// .base-theme footer rule owns the content footer instead. Every other theme
// keeps the Open Lobby tokens. Defaults to the token chrome so direct users
// outside Shell keep today's rendering.
let {
  theme = null,
}: {
  theme?: "home" | "event" | "content" | "join" | "profile" | "schedule" | null;
} = $props();

const footerClass = $derived(
  theme === "content" ? "" : "border-t border-lobby-line bg-lobby-raised text-lobby-muted",
);
</script>

<!-- Original footer chrome: Open Lobby surface/muted tokens, never pasted
  Plus markup. Legal and community links are the production set. -->
<footer class={footerClass}>
  Together We Own · adult gaming community · founded 1998
  <nav aria-label="Site">
    <a href="/about">About</a> <a href="/faq">FAQ</a> <a href="/rules">House rules</a>
    <a href="/privacy">Privacy</a>
  </nav>
</footer>
