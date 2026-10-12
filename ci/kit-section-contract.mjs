// Shared Kit/Hono section comparison (TOG-22120).
//
// The canonical treatment lives in ci/kit-preview-e2e.mjs
// (stripHydrationMarkers/normalize): Svelte SSR emits hydration markers with
// no Hono counterpart, boolean-attribute serialization differs per framework,
// `>` escaping is serializer-owned, and inter-tag whitespace is a serializer
// choice. Every parity comparison (preview fetches, Playwright cross-target)
// must apply this treatment, or a correct Kit render fails on framework
// bytes alone. Keep in sync with kit-preview-e2e.mjs; that script keeps its
// own copy because it runs on import and cannot take on callers.
export function stripHydrationMarkers(html) {
  let previous;
  do {
    previous = html;
    html = html.replace(/<!--\[[\d-]*-->|<!--\]-->/g, "");
  } while (html !== previous);
  return html;
}

export function normalizeSection(html) {
  return (
    stripHydrationMarkers(html)
      // Boolean-attribute serialization differs per framework (bare, ="",
      // ="true"); the contract is presence, pinned separately.
      .replace(/=(?:""|"true")(?=[\s>])/g, "")
      // `>` escaping is serializer-owned (Hono emits &gt;, Svelte a bare >);
      // the security-relevant escapes (&amp;, &lt;, quotes) are pinned exactly.
      .replace(/&gt;/g, ">")
      // Inter-tag whitespace is a serializer choice, not a contract.
      .replace(/>\s+</g, "><")
      .trim()
  );
}

export function sectionOf(html, testid) {
  const pattern = new RegExp(`<section[^>]*data-testid="${testid}"[\\s\\S]*?<\\/section>`);
  const match = html.match(pattern);
  if (!match) throw new Error(`section ${testid} is missing`);
  return normalizeSection(match[0]);
}
