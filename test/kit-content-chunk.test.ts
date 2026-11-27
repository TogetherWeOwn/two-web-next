// The content-leaf response shaping (src/kit-content-chunk.ts): the served
// Kit worker must carry zero render-blocking stylesheet links on content
// leaves and paint <body> with the Hono body class, so the inlined leaf
// block owns the canvas.
import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { transformContentLeafChunk } from "../src/kit-content-chunk";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

const LAYOUT_LINK = '<link href="./_app/immutable/assets/0.B5UzpxCz.css" rel="stylesheet">';
const parserOptions = { scriptingEnabled: false, sourceCodeLocationInfo: true };
const tags = (html: string, tagName: string) =>
  elements(parse(html, parserOptions)).filter((el) => el.tagName === tagName);
const headChildren = (html: string) =>
  tags(html, "head")[0]?.childNodes.map((node) => node.nodeName);

describe("transformContentLeafChunk", () => {
  it("strips the layout stylesheet link", () => {
    const html = `<head>${LAYOUT_LINK}<title>x</title></head><body><div>hi</div></body>`;
    const out = transformContentLeafChunk(html);
    const nodes = elements(parse(out, parserOptions));
    expect(nodes.map((el) => el.tagName)).toEqual(["html", "head", "title", "body", "div"]);
    const classValue = "base-theme content-theme";
    expect(nodes.flatMap((el) => el.attrs)).toEqual([{ name: "class", value: classValue }]);
    expect(tags(out, "title").map(textOf)).toEqual(["x"]);
    expect(tags(out, "body").map(textOf)).toEqual(["hi"]);
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
      const out = transformContentLeafChunk(`<head>${link}</head><body></body>`);
      expect(headChildren(out), link).toEqual([]);
      expect(tags(out, "body")[0]?.childNodes, link).toEqual([]);
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
    const links = tags(out, "link");
    const destinations = links.map((el) => [attr(el, "rel"), attr(el, "href")]);
    expect(headChildren(out)).toEqual(Array(6).fill("link"));
    expect(destinations).toContainEqual(["preload", "/fonts/display-latin-700.woff2"]);
    expect(destinations).toContainEqual(["canonical", "https://next.example.test/about"]);
    expect(destinations).toContainEqual(["alternate", "/events.rss"]);
    expect(destinations).toContainEqual(["alternate", "/about.md"]);
    expect(destinations).toContainEqual(["manifest", "/site.webmanifest"]);
    expect(destinations).toContainEqual(["icon", "/icons/icon-192.png"]);
    const font = links.find((el) => attr(el, "rel") === "preload");
    expect(font && attr(font, "as")).toBe("font");
    expect(links.some((el) => attr(el, "as") === "style")).toBe(false);
    expect(tags(out, "body")[0]?.childNodes).toEqual([]);
  });

  it("paints a bare body with the Hono body class", () => {
    const out = transformContentLeafChunk("<head></head><body><div>hi</div></body>");
    expect(tags(out, "body").map((el) => attr(el, "class"))).toEqual(["base-theme content-theme"]);
  });

  it("merges into an existing body class instead of duplicating the tag", () => {
    const out = transformContentLeafChunk('<head></head><body class="app"><div>hi</div></body>');
    const [body] = tags(out, "body");
    expect(body && attr(body, "class")).toBe("app base-theme content-theme");
    const startTag = body?.sourceCodeLocation?.startTag;
    // HTML parsing folds duplicate body tags into one node. Check the bytes after its opening tag.
    expect(startTag && out.slice(startTag.endOffset)).toBe("<div>hi</div></body>");
  });

  it("leaves the inlined leaf style block byte-identical", () => {
    const style = "<style>:root{--ink:#16130f}\r\nbody{margin:0}</style>";
    const html = `<head>${style}${LAYOUT_LINK}</head><body></body>`;
    const out = transformContentLeafChunk(html);
    const [inline, extra] = tags(out, "style");
    expect(extra).toBeUndefined();
    const location = inline?.sourceCodeLocation;
    expect(location && out.slice(location.startOffset, location.endOffset)).toBe(style);
  });

  it("is a no-op on a document that already meets the contract", () => {
    const html =
      '<head><style>a{color:red}</style></head><body class="base-theme content-theme"></body>';
    expect(transformContentLeafChunk(html)).toBe(html);
  });
});
