import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compileKitFixture as render } from "./kit-hydration-harness.mjs";

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const font = (name) =>
  `url(data:font/woff2;base64,${readFileSync(file(`public/fonts/${name}.woff2`), "base64")})`;

test("Lifeline renders each synthetic state without JavaScript or routes", async (t) => {
  const { compile } = createRequire(file("web/package.json"))("@tailwindcss/node");
  const options = { base: file("web/src"), onDependency: () => {} };
  const theme = await compile(readFileSync(file("web/src/app.css"), "utf8"), options);
  const { body, css } = await render({ fixture: file("test/fixtures/kit-lifeline.svelte") });
  const styles = `${theme.build([])}\n${css}
    @font-face { font-family: Mona Sans; src: ${font("mona-sans-latin-var")}; font-weight: 200 900; }
    @font-face { font-family: Fragment Mono; src: ${font("fragment-mono-latin-400")}; }
    body { margin: 0; }
    main { max-width: 640px; margin: auto; padding: var(--space-6); }
  `;
  const examples = {
    upcoming: /Sign-ups opened.*Your seat is saved.*Site · Next.*Reminder ping/s,
    frozen:
      /8 sent · 2 unavailable.*Bot · Counting now.*Waiting on the bot\. Last synced 12 min ago/s,
    cancelled: /Event room seen.*Event cancelled.*severe weather\./s,
    ended: /Counting window closed.*Echo frozen/s,
  };
  const clocks = {
    upcoming: ["18:00", "18:23", "19:30", "19:45", "20:00", "21:25"],
    frozen: ["18:00", "19:32", "19:45", "20:00", "21:25"],
    cancelled: ["18:00", "18:23", "20:00", "20:01"],
    ended: ["18:00", "19:32", "20:00", "21:15", "21:41"],
  };
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1280, 390]) {
    const viewport = { width, height: width === 390 ? 844 : 800 };
    const page = await browser.newPage({ viewport, javaScriptEnabled: false });
    for (const [state, expected] of Object.entries(examples)) {
      await page.setContent(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lifeline fixture</title><style>${styles}\n[data-fixture]:not([data-fixture="${state}"]) { display: none; }</style></head><body class="base-theme">${body}</body></html>`,
      );
      const section = page.getByRole("region", { name: "Lifeline" });
      const text = (await section.textContent()) ?? "";
      assert.match(text, expected);
      assert.doesNotMatch(text, /Pull me in|no.show/i);
      assert.equal(await section.locator("a, button, script, [aria-live]").count(), 0);
      const ongoing = state === "upcoming" || state === "frozen";
      assert.equal(await section.locator('[aria-current="step"]').count(), Number(ongoing));
      const rows = await section.locator("ol > li").all();
      assert.equal(rows.length, clocks[state].length, `${state}: row count`);
      for (const [index, row] of rows.entries()) {
        const clock = clocks[state][index];
        const stamp = row.locator("time[datetime]", { hasText: `${clock} UTC` });
        const label = row.locator(".entry");
        const context = `${state}: ${clock} at ${width}px`;
        assert.ok((await stamp.isVisible()) && (await label.isVisible()), `${context}: visibility`);
        const [time, entry] = await Promise.all([stamp.boundingBox(), label.boundingBox()]);
        assert.ok(time && entry, `${context}: bounds`);
        const above = time.y + time.height <= entry.y;
        const aligned = time.y >= entry.y && time.y < entry.y + entry.height;
        assert.ok(width === 390 ? above : aligned && time.x + time.width <= entry.x, context);
      }
      assert.ok(await section.evaluate((el) => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `artifacts/kit-lifeline/${state}-${width}.png` });
    }
    assert.ok((await page.consoleMessages()).every((message) => message.type() !== "error"));
  }
});
