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
    ]) {
      const ancestor = kind.endsWith("-ancestor");
      const claim = normalizeIntent([
        {
          id: "paint",
          claim: ancestor ? "Change padding" : "Change opacity",
          selector: '[data-testid="paint"]',
          prop: ancestor ? "padding-top" : "opacity",
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
        const mark = `<${tag} data-testid="paint" ${tag === "img" ? `src="data:image/png;base64,${PNG.sync.write(image).toString("base64")}"` : ""}>${tag === "svg" ? `<path d="${after ? "M0 0L100 0L100 100Z" : "M0 0L100 100L0 100Z"}" fill="red"/>` : ""}</${tag}>`;
        await page.setContent(
          `<style>body{margin:0;background:white}
          [data-testid="paint"]{position:absolute;left:40px;top:40px;width:100px;height:100px;opacity:${after ? 1 : 0.4};background:${background};${kind === "border" ? `border:10px ${after ? "dashed" : "solid"} red;` : ""}}
          ${kind === "pseudo" ? `[data-testid="paint"]::before{content:"";position:absolute;inset:10px;background:${after ? "blue" : "red"}}` : ""}
          ${ancestor ? `#ancestor{position:absolute;left:40px;top:40px;width:100px;height:${after ? 120 : 100}px;${kind === "gradient-ancestor" ? "background:linear-gradient(red,blue)" : ""}}[data-testid="paint"]{position:static;opacity:1;width:60px;height:40px;padding-top:${after ? 4 : 2}px}` : ""}
          #generated{position:absolute;left:190px;top:190px;width:0;height:0;${kind === "hidden-pseudo" ? "display:none" : ""}}
          #generated::before{content:"";display:block;position:absolute;width:40px;height:40px;background:${after ? "blue" : "red"}}
          </style>${ancestor ? `<div id="ancestor">${mark}</div>` : mark}${kind.endsWith("pseudo") && kind !== "pseudo" ? `<div ${kind === "hidden-parent-pseudo" ? 'style="display:none"' : ""}><div id="generated">Menu</div></div>` : ""}`,
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
        if (kind.startsWith("hidden-"))
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
      const { items } = attribute(
        captures[0].elements,
        captures[1].elements,
        diff.regions,
        claim,
        new Map([["a.css", [[2, 3]]]]),
        "head",
        { id: "paint", width: 300, height: 300 },
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
