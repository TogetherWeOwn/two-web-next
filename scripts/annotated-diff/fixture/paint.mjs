import assert from "node:assert/strict";
import { chromium } from "playwright";
import { PNG } from "pngjs";

export async function verifyPaint({ attribute, normalizeIntent, regions, captureDOM }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
    let asset;
    await page.route("https://fixture.invalid/paint.png", (route) =>
      route.fulfill({ body: asset, contentType: "image/png" }),
    );
    const failures = [];
    for (const kind of [
      "plain",
      "gradient",
      "url",
      "canvas",
      "img",
      "border",
      "pseudo",
      "svg",
      "gradient-ancestor",
      "transparent-ancestor",
      "hidden-pseudo",
      "hidden-parent-pseudo",
      "overflow-pseudo",
      "hidden-visibility-pseudo",
      "hidden-host-visible-pseudo",
      "svg-overflow",
      "svg-zero-overflow",
      "svg-overflow-before",
      "svg-overflow-after",
      "svg-zero-overflow-before",
      "svg-zero-overflow-after",
      "svg-hidden",
      "svg-offscreen",
      "direct-text-ancestor",
      "decoration-currentcolor",
      "decoration-explicit",
      "outline-currentcolor",
      "outline-explicit",
      ...["html", "body"].flatMap((tag) =>
        ["before", "after", "marker"].flatMap((pseudo) =>
          ["before", "after"].map((half) => `root-${tag}-${pseudo}-${half}`),
        ),
      ),
      "root-body-zero",
      "root-html-zero",
    ]) {
      const ancestor = kind.endsWith("-ancestor");
      const color = kind.startsWith("decoration-") || kind.startsWith("outline-");
      const root = kind.startsWith("root-") ? kind.split("-") : null;
      const claim = normalizeIntent([
        {
          id: "paint",
          claim: ancestor ? "Change padding" : color ? "Change color" : "Change opacity",
          selector: '[data-testid="paint"]',
          prop: ancestor ? "padding-top" : color ? "color" : "opacity",
          file: "a.css",
          line: 2,
        },
      ]);
      const captures = [];
      for (const after of [false, true]) {
        const image = new PNG({ width: 1, height: 1 });
        image.data.set(after ? [0, 0, 255, 255] : [255, 0, 0, 255]);
        asset = PNG.sync.write(image);
        const background =
          kind === "url"
            ? 'url("https://fixture.invalid/paint.png")'
            : kind === "gradient"
              ? `linear-gradient(${after ? "blue,green" : "red,black"})`
              : "black";
        const tag = ["canvas", "img", "svg"].includes(kind) ? kind : "div";
        const mark = `<${tag} data-testid="paint" ${tag === "img" ? `src="data:image/png;base64,${PNG.sync.write(image).toString("base64")}"` : ""}>${tag === "svg" ? `<path d="${after ? "M0 0L100 0L100 100Z" : "M0 0L100 100L0 100Z"}" fill="red"/>` : color ? "Measured text" : ""}</${tag}>`;
        const svgActive =
          kind.startsWith("svg-") &&
          ((!kind.endsWith("-before") && !kind.endsWith("-after")) ||
            kind.endsWith(after ? "-after" : "-before"));
        const rootActive = root && (root[2] === "zero" || root[3] === (after ? "after" : "before"));
        const rootPseudo = root?.[2] === "zero" ? "before" : root?.[2];
        await page.setContent(
          `<style>body{margin:0;background:white}
          [data-testid="paint"]{position:absolute;left:40px;top:40px;width:100px;height:100px;opacity:${after ? 1 : 0.4};background:${background};${kind === "border" ? `border:10px ${after ? "dashed" : "solid"} red;` : ""}}
          ${kind === "pseudo" ? `[data-testid="paint"]::before{content:"";position:absolute;inset:10px;background:${after ? "blue" : "red"}}` : ""}
          ${ancestor ? `#ancestor{position:absolute;left:40px;top:40px;width:100px;height:${after ? 120 : 100}px;${kind === "gradient-ancestor" ? "background:linear-gradient(red,blue)" : ""}}[data-testid="paint"]{position:static;opacity:1;width:60px;height:40px;padding-top:${after ? 4 : 2}px}` : ""}
          #generated{position:absolute;left:190px;top:190px;width:0;height:0;${kind === "hidden-pseudo" ? "display:none" : ""}}
          #generated::before{content:"";display:block;position:absolute;width:40px;height:40px;background:${after ? "blue" : "red"}}
          ${kind === "hidden-visibility-pseudo" || kind === "hidden-host-visible-pseudo" ? `#generated{visibility:hidden}#generated::before{visibility:${kind === "hidden-host-visible-pseudo" ? "visible" : "hidden"}}` : ""}
          ${kind === "direct-text-ancestor" ? `#ancestor{width:${after ? 120 : 100}px;height:auto;font:20px Arial}` : ""}
          ${color ? `[data-testid="paint"]{opacity:1;background:white;font:20px Arial;color:${after ? "blue" : "red"};${kind.startsWith("decoration-") ? "text-decoration:underline; text-decoration-color" : "outline:4px solid;outline-color"}:${kind.endsWith("explicit") ? (after ? "blue" : "red") : "currentcolor"}}` : ""}
          ${root ? `${root[1]}{${rootPseudo === "marker" ? "display:list-item;list-style-position:inside;" : ""}${root[2] === "zero" ? "width:0;height:0;" : ""}}${root[1]}::${rootPseudo}{content:${rootActive ? '"Overlay"' : "none"};position:absolute;left:45px;top:45px;width:70px;height:70px;background:${after ? "blue" : "red"};color:${after ? "blue" : "red"}}` : ""}
          </style>${ancestor ? `<div id="ancestor">${kind === "direct-text-ancestor" ? "Alpha beta gamma delta epsilon" : ""}${mark}</div>` : mark}${kind.endsWith("pseudo") && kind !== "pseudo" ? `<div ${kind === "hidden-parent-pseudo" ? 'style="display:none"' : ""}><div id="generated">Menu</div></div>` : ""}
          ${svgActive ? `<svg id="overflow" width="${kind.includes("zero-overflow") ? 0 : 10}" height="${kind.includes("zero-overflow") ? 0 : 10}" style="position:absolute;left:${kind === "svg-offscreen" ? 500 : 190}px;top:40px;overflow:visible;${kind === "svg-hidden" ? "display:none" : ""}"><path d="M-150 0h80v80h-80Z" fill="${after ? "blue" : "red"}"/></svg>` : ""}`,
        );
        await page.evaluate(
          async ({ after, kind }) => {
            const e = document.querySelector('[data-testid="paint"]');
            if (kind === "img") await e.decode();
            if (kind === "canvas") {
              const ctx = e.getContext("2d");
              ctx.fillStyle = after ? "blue" : "red";
              ctx.fillRect(0, 0, e.width, e.height);
            }
          },
          { after, kind },
        );
        const dom = await captureDOM(page, { font: "Arial" });
        if (["hidden-pseudo", "hidden-parent-pseudo"].includes(kind))
          assert(
            !dom.elements.some((e) => e.selector === "#generated"),
            "Hidden pseudo host must not enter font or paint evidence",
          );
        if (kind === "overflow-pseudo") {
          const generated = dom.elements.find((e) => e.selector === "#generated");
          assert.equal(generated.rect.w, 0);
          assert.equal(generated.rect.h, 0);
          assert.deepEqual(generated.pseudos, ["::before"]);
        }
        for (const tag of ["html", "body"]) {
          const sentinels = dom.elements.filter((e) => e.root_paint_sentinel === tag);
          assert.equal(sentinels.length, 1, `${kind}: ${tag} sentinel`);
          assert(Array.isArray(sentinels[0].pseudos));
          assert.equal(sentinels[0].rect, undefined, "Root sentinels must not compete as boxes");
        }
        if (rootActive) {
          assert(
            dom.elements
              .find((e) => e.root_paint_sentinel === root[1])
              .pseudos.includes(`::${rootPseudo}`),
            kind,
          );
          if (root[2] === "zero")
            assert.deepEqual(
              await page.locator(root[1]).evaluate((e) => {
                const r = e.getBoundingClientRect();
                return [r.width, r.height];
              }),
              [0, 0],
            );
        }
        if (svgActive) {
          const svg = dom.elements.find((e) => e.selector === "#overflow");
          assert.equal(svg.tag, "svg", kind);
          if (kind.includes("zero-overflow") || kind === "svg-hidden")
            assert.deepEqual([svg.rect.w, svg.rect.h], [0, 0], kind);
        }
        if (kind === "hidden-host-visible-pseudo" || kind === "hidden-visibility-pseudo")
          assert.deepEqual(dom.elements.find((e) => e.selector === "#generated").pseudos, [
            "::before",
          ]);
        const measured = dom.elements.find((e) => e.testid === "paint");
        assert.equal(measured.key, "testid:paint");
        assert(measured.depth > 0 && measured.ancestors.includes("body"));
        if (kind === "direct-text-ancestor") {
          const parent = dom.elements.find((e) => e.selector === "#ancestor");
          assert.equal(parent.text, "Alpha beta gamma delta epsilon");
          assert(parent.depth < measured.depth);
        }
        captures.push({ elements: dom.elements, image: PNG.sync.read(await page.screenshot()) });
      }
      const diff = regions(captures[0].image, captures[1].image, 1);
      assert(diff.regions.length > 0, kind);
      if (kind === "svg")
        assert.deepEqual(
          captures[0].elements.map((e) => e.rect),
          captures[1].elements.map((e) => e.rect),
          "SVG replacement must preserve every measured bound",
        );
      const attributeCaptures = (elements) =>
        attribute(
          elements[0],
          elements[1],
          diff.regions,
          claim,
          new Map([["a.css", [[2, 3]]]]),
          "head",
          { id: "paint", width: 300, height: 300 },
        );
      const { items, matches } = attributeCaptures(captures.map((c) => c.elements));
      assert(matches.every((m) => ![m.before, m.after].some((e) => e?.root_paint_sentinel)));
      if (kind === "plain" || kind === "transparent-ancestor") {
        for (const half of [0, 1]) {
          for (const missing of kind === "plain" ? ["html", "body", "pseudos"] : ["text"]) {
            const inventories = captures.map((c) => structuredClone(c.elements));
            if (missing === "text")
              delete inventories[half].find((e) => e.selector === "#ancestor").text;
            else if (missing === "pseudos")
              delete inventories[half].find((e) => e.root_paint_sentinel === "body").pseudos;
            else
              inventories[half] = inventories[half].filter(
                (e) => e.root_paint_sentinel !== missing,
              );
            const result = attributeCaptures(inventories);
            assert(
              result.items.filter((i) => i.regions.length).every((i) => i.status === "unexplained"),
              `${kind}: missing ${missing} in half ${half}`,
            );
            assert.equal(
              result.items.find((i) => i.intent_ref === "paint").verification.valid,
              true,
            );
          }
        }
      }
      if (kind.startsWith("svg-")) {
        const host = captures
          .flatMap((c) => c.elements)
          .find((e) => e.selector === "#overflow").rect;
        assert(
          diff.regions.every((r) => r.bbox_css.x + r.bbox_css.w < host.x || !host.w),
          "SVG host bounds must not intersect changed regions",
        );
      }
      if (kind === "direct-text-ancestor")
        assert(
          items.some(
            (i) =>
              i.regions.length && i.contributors.some((c) => c.element.selector === "#ancestor"),
          ),
          "Direct text must remain an independent contributor",
        );
      const owners = items.filter((i) => i.regions.length);
      const expected = [
        "plain",
        "transparent-ancestor",
        "hidden-pseudo",
        "hidden-parent-pseudo",
      ].includes(kind)
        ? "explained"
        : "unexplained";
      if (owners.some((i) => i.status !== expected))
        failures.push(
          `${kind}: expected ${expected}, got ${owners.map((i) => i.status).join(",")}`,
        );
      assert.equal(items.find((i) => i.intent_ref === "paint").verification.valid, true, kind);
      if (["canvas", "img", "svg", "pseudo"].includes(kind))
        for (const owner of owners)
          if (owner.status === "unexplained") assert.equal(owner.element, null, kind);
    }
    assert.deepEqual(failures, [], "Independent paint must not ride a narrower claim");
  } finally {
    await browser.close();
  }
}
