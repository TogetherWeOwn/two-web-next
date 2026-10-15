<script lang="ts">
import { escapeJsonLdText } from "../../../src/seo-json-ld";

// One JSON-LD data block per entity. Data blocks are not executed, so the CSP
// (script-src 'self') is unaffected. Svelte parses <script> content as raw
// text, so the element is built as a markup string and the closing tag is
// split: this file never holds a literal script closer. The payload is
// re-escaped here (a no-op on already-escaped payloads) so the seam holds
// without relying on every caller.
let { testid, json }: { testid: "event-jsonld" | "site-jsonld"; json: string } = $props();
const tag = $derived(
  '<script type="application/ld+json" data-testid="' +
    testid +
    '">' +
    escapeJsonLdText(json) +
    "</" +
    "script>",
);
</script>

{@html tag}
