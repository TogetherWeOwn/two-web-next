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

test("Lifeline renders each synthetic state without JavaScript or routes", async () => {
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
    cancelled: /Event cancelled.*The host cancelled because of severe weather\./s,
    ended: /Counting window closed.*Echo frozen/s,
  };
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      const viewport = { width, height: width === 1280 ? 800 : 844 };
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
        assert.equal(
          await section.locator('[aria-current="step"]').count(),
          Number(state === "upcoming" || state === "frozen"),
        );
        if (state === "cancelled") assert.equal(await section.getByRole("listitem").count(), 3);
        const fits = await section.evaluate((el) => el.scrollWidth <= el.clientWidth);
        assert.ok(fits, `${state} fits at ${width}px`);
        await page.screenshot({ path: `artifacts/kit-lifeline/${state}-${width}.png` });
      }
      const messages = await page.consoleMessages();
      assert.ok(messages.every((message) => message.type() !== "error"));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
