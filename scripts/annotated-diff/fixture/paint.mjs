import assert from "node:assert/strict";
import { chromium } from "playwright";
import { PNG } from "pngjs";

export async function verifyPaint({ attribute, normalizeIntent, regions, STYLES }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
    let asset;
    await page.route("https://fixture.invalid/paint.png", (route) =>
      route.fulfill({ body: asset, contentType: "image/png" }),
    );
    const claim = normalizeIntent([
      {
        id: "paint",
        claim: "Change opacity",
        selector: "#paint",
        prop: "opacity",
        file: "a.css",
        line: 2,
      },
    ]);
    for (const kind of ["plain", "gradient", "url", "canvas", "img"]) {
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
        const tag = ["canvas", "img"].includes(kind) ? kind : "div";
        await page.setContent(
          `<style>body{margin:0;background:white}#paint{position:absolute;left:40px;top:40px;width:100px;height:100px;opacity:${after ? 1 : 0.4};background:${background}}</style><${tag} id="paint" data-testid="paint" ${tag === "img" ? `src="data:image/png;base64,${PNG.sync.write(image).toString("base64")}"` : ""}></${tag}>`,
        );
        await page.evaluate(
          async ({ after, kind }) => {
            const e = document.querySelector("#paint");
            if (kind === "img") await e.decode();
            if (kind === "canvas") {
              const ctx = e.getContext("2d");
              ctx.fillStyle = after ? "blue" : "red";
              ctx.fillRect(0, 0, e.width, e.height);
            }
          },
          { after, kind },
        );
        const element = await page.evaluate((props) => {
          const e = document.querySelector("#paint"),
            s = getComputedStyle(e),
            r = e.getBoundingClientRect();
          return {
            key: "testid:paint",
            selector: "#paint",
            testid: "paint",
            tag: e.tagName.toLowerCase(),
            depth: 2,
            role: null,
            name: "Paint",
            text: "",
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            style: Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])),
            paint: { "background-image": s.backgroundImage },
          };
        }, STYLES);
        captures.push({ element, image: PNG.sync.read(await page.screenshot()) });
      }
      const diff = regions(captures[0].image, captures[1].image, 1);
      assert(diff.regions.length > 0, kind);
      const { items } = attribute(
        [captures[0].element],
        [captures[1].element],
        diff.regions,
        claim,
        new Map([["a.css", [[2, 3]]]]),
        "head",
        { id: "paint", width: 300, height: 300 },
      );
      const owner = items.find((i) => i.regions.length);
      assert.equal(owner.status, kind === "plain" ? "explained" : "unexplained", kind);
      assert.equal(items.find((i) => i.intent_ref === "paint").verification.valid, true, kind);
      if (["canvas", "img"].includes(kind)) assert.equal(owner.element, null, kind);
    }
  } finally {
    await browser.close();
  }
}
