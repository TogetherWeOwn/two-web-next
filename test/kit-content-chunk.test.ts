// The content-leaf response shaping (src/kit-content-chunk.ts): the served
// Kit worker must carry zero render-blocking stylesheet links on content
// leaves and paint <body> with the Hono body class, so the inlined leaf
// block owns the canvas.
import { describe, expect, it } from "vitest";
import { transformContentLeafChunk } from "../src/kit-content-chunk";

const LAYOUT_LINK = '<link href="./_app/immutable/assets/0.B5UzpxCz.css" rel="stylesheet">';

describe("transformContentLeafChunk", () => {
  it("strips the layout stylesheet link", () => {
    const html = `<head>${LAYOUT_LINK}<title>x</title></head><body><div>hi</div></body>`;
    const out = transformContentLeafChunk(html);
    expect(out).not.toContain('rel="stylesheet"');
    expect(out).not.toContain("_app/immutable/assets");
    expect(out).toContain("<title>x</title>");
  });

  it("strips stylesheet links in any attribute order, quote style or case", () => {
    const variants = [
      '<link rel="stylesheet" href="/a.css">',
      "<link rel='stylesheet' href='/a.css'>",
      '<link href="/a.css" rel="stylesheet">',
      '<link data-x="1" href="/a.css" rel="stylesheet" media="all">',
      '<LINK REL="stylesheet" HREF="/a.css">',
    ];
    for (const link of variants) {
      expect(transformContentLeafChunk(`<head>${link}</head><body></body>`)).not.toContain(
        "/a.css",
      );
    }
  });

  it("strips preload-as-style links but keeps the font preload and alternates", () => {
    const html =
      "<head>" +
      '<link rel="preload" as="style" href="/late.css">' +
      '<link rel="preload" href="/fonts/display-latin-700.woff2" as="font" type="font/woff2" crossorigin="anonymous">' +
      '<link rel="canonical" href="https://next.example.test/about">' +
      '<link rel="alternate" type="application/rss+xml" title="TWO Events" href="/events.rss">' +
      '<link rel="alternate" type="text/markdown" title="Markdown version" href="/about.md">' +
      '<link rel="manifest" href="/site.webmanifest">' +
      '<link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192">' +
      "</head><body></body>";
    const out = transformContentLeafChunk(html);
    expect(out).not.toContain('as="style"');
    expect(out).toContain('as="font"');
    expect(out).toContain('rel="canonical"');
    expect(out).toContain("/events.rss");
    expect(out).toContain("/about.md");
    expect(out).toContain("/site.webmanifest");
    expect(out).toContain("/icons/icon-192.png");
  });

  it("paints a bare body with the Hono body class", () => {
    const out = transformContentLeafChunk("<head></head><body><div>hi</div></body>");
    expect(out).toContain('<body class="base-theme content-theme">');
  });

  it("merges into an existing body class instead of duplicating the tag", () => {
    const out = transformContentLeafChunk('<head></head><body class="app"><div>hi</div></body>');
    expect(out).toContain('<body class="app base-theme content-theme">');
    expect(out.match(/<body/g)?.length).toBe(1);
  });

  it("leaves the inlined leaf style block byte-identical", () => {
    const css = ":root{--ink:#16130f}body{margin:0}";
    const html = `<head><style>${css}</style>${LAYOUT_LINK}</head><body></body>`;
    const out = transformContentLeafChunk(html);
    expect(out).toContain(`<style>${css}</style>`);
  });

  it("is a no-op on a document that already meets the contract", () => {
    const html =
      '<head><style>a{color:red}</style></head><body class="base-theme content-theme"></body>';
    expect(transformContentLeafChunk(html)).toBe(html);
  });
});
