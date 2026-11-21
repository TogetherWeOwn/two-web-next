import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compileKitFixture } from "./kit-hydration-harness.mjs";

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const font = (name) =>
  `url(data:font/woff2;base64,${readFileSync(file(`public/fonts/${name}.woff2`), "base64")})`;

test("Lifeline renders each synthetic state without JavaScript or routes", async (t) => {
  const { compile } = createRequire(file("web/package.json"))("@tailwindcss/node");
  const options = { base: file("web/src"), onDependency: () => {} };
  const css = await compile(readFileSync(file("web/src/app.css"), "utf8"), options);
  const fixture = file("test/fixtures/kit-lifeline.svelte");
  const { body, css: scoped } = await compileKitFixture({ fixture });
  const styles = `${css.build([])}\n${scoped}
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
      const rows = await section.getByRole("listitem").all();
      if (state === "cancelled") assert.equal(rows.length, 4);
      for (const row of rows) {
        const time = await row.locator("time[datetime]", { hasText: /\d/ }).boundingBox();
        const entry = await row.locator(".entry").boundingBox();
        assert.ok(time && entry, `${state}: visible timestamp and entry at ${width}px`);
        const stacked = time.y + time.height <= entry.y;
        assert.equal(stacked, width === 390, `${state}: timestamp layout at ${width}px`);
      }
      assert.ok(await section.evaluate((el) => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: `artifacts/kit-lifeline/${state}-${width}.png` });
    }
    const messages = await page.consoleMessages();
    assert.ok(messages.every((message) => message.type() !== "error"));
  }
});
