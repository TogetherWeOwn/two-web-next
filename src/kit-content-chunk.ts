// Content-leaf response shaping for the Kit branch.
//
// The Kit root layout (web/src/routes/+layout.svelte) pulls the Tailwind
// pipeline (web/src/app.css) into every Kit page as a render-blocking
// stylesheet asset (~2.6 kB raw, about one round trip / ~180 ms on throttled
// mobile). The content leaves (/about, /faq, /rules, /privacy) are styled
// solely by the inlined LEAF_CRITICAL_CSS block (Hono parity since #808), so
// that link buys nothing there — but SvelteKit emits the layout asset for
// every page under the root layout, and the root layout applies to every
// page, so the content shell cannot opt out from a component. The dispatch
// (src/route-ownership.ts) therefore passes this transform as the Kit
// resolve transformPageChunk for content-leaf paths only: the link is
// stripped after resolve, and <body> is painted with the Hono body class so
// the leaf block owns the canvas (body background, overscroll, bar tint)
// with no external request. Every other route resolves untouched.
export function transformContentLeafChunk(html: string): string {
  // Strip render-blocking stylesheet links (the Tailwind/layout asset) in any
  // attribute order or quote style. Alternate, canonical, preload-as-font,
  // manifest and icon links carry no rel=stylesheet and survive. A second
  // pass drops preload-as-style the same way: neither form may ship on a
  // content leaf.
  const withoutStylesheets = html
    .replace(/<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1[^>]*>\s*/gi, "")
    .replace(/<link\b[^>]*\bas\s*=\s*(["'])style\1[^>]*>\s*/gi, "");
  // Hono parity: the Hono content shell renders
  // <body class="base-theme content-theme">, so the leaf block's .base-theme
  // rule paints the body dark. The Kit app shell renders a bare <body> and
  // leans on the layout stylesheet's `html body` rule instead — without it
  // the body falls back to the light --paper. Merging into an existing class
  // attribute keeps the transform safe if the shell ever gains one.
  return withoutStylesheets.replace(/<body([^>]*)>/i, (match, attrs: string) => {
    const existing = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    if (existing) {
      // Dedupe so a repeated pass never stacks the classes twice.
      const quote = existing[1] ?? '"';
      const have = (existing[2] ?? "").split(/\s+/).filter(Boolean);
      const merged = [...have, "base-theme", "content-theme"]
        .filter((cls, i, all) => all.indexOf(cls) === i)
        .join(" ");
      return match.replace(existing[0], `class=${quote}${merged}${quote}`);
    }
    return `<body${attrs} class="base-theme content-theme">`;
  });
}
