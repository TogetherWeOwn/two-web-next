import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compileKitFixture } from "./kit-hydration-harness.mjs";

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const origin = "https://event-detail.example.test";
const path = "/e/fixture-raid";
const publicAssets = new Set([
  "/styles.css",
  "/theme.css",
  "/event-theme.css",
  "/logo.svg",
  "/fonts/mona-sans-latin-wght.woff2",
  "/fonts/fragment-mono-latin-400.woff2",
  "/fonts/instrument-serif-latin-400-italic.woff2",
]);

async function openFixture(page, { body, head }, styles, enhanced = false) {
  await page.unrouteAll();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === path && request.method() === "GET") {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>${styles}</style></head><body>${body}</body></html>`,
      });
    }
    if (publicAssets.has(url.pathname))
      return route.fulfill({ path: file(`public${url.pathname}`) });
    if (url.pathname === `${path}/rsvp` && request.method() === "POST") {
      return route.fulfill({ body: "Synthetic form submission" });
    }
    if (enhanced && url.pathname === "/events/fixture-raid/rsvp" && request.method() === "PUT") {
      return route.fulfill({ json: { data: { status: "going" } } });
    }
    if (enhanced && url.pathname === "/islands/rsvp-button.js") {
      return route.fulfill({ path: file("public/islands/rsvp-button.js") });
    }
    // This fixture executes only the RSVP island; no other script or endpoint goes live.
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}${path}`);
}

function existingControls(page) {
  return page
    .locator(".event-layout-head, .event-layout-rail, .event-seat-bar, script[src]")
    .evaluateAll((elements) => elements.map((el) => el.outerHTML));
}

const examples = {
  upcoming:
    /Sign-ups opened.*Save a seat while sign-ups are open.*Site · Next.*Reminder ping.*Bot · Planned/s,
  frozen:
    /8 sent · 2 unavailable.*Bot · Counting now.*Waiting on the bot\. Last synced 12 min ago/s,
  cancelled: /Your seat is saved.*Event room seen.*Event cancelled.*severe weather\./s,
  ended: /Counting window closed.*Site · Waiting.*Echo freezes.*Waiting on the site\./s,
};

test("EventDetail places the read-only Lifeline after the seat rail and preserves RSVP", async () => {
  const webRequire = createRequire(file("web/package.json"));
  const { compile } = webRequire("@tailwindcss/node");
  const { Scanner } = webRequire("@tailwindcss/oxide");
  const options = { base: file("web/src"), onDependency: () => {} };
  const css = await compile(readFileSync(file("web/src/app.css"), "utf8"), options);
  const fixture = file("test/fixtures/kit-lifeline.svelte");
  const { renderFixture, css: scoped } = await compileKitFixture({ fixture, ssrOnly: true });
  const styles = `${css.build(new Scanner({ sources: css.sources }).scan())}\n${scoped}`;
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      const compact = width === 390;
      const viewport = { width, height: compact ? 844 : 800 };
      const page = await browser.newPage({ viewport, javaScriptEnabled: false });
      const section = page.getByRole("region", { name: "Lifeline" });
      const capture = (state) =>
        page.screenshot({
          path: `artifacts/kit-lifeline/${state}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      await openFixture(page, renderFixture({ state: "upcoming", showLifeline: false }), styles);
      assert.equal(await section.count(), 0);
      const before = await existingControls(page);
      await capture("before");

      for (const [state, expected] of Object.entries(examples)) {
        await openFixture(page, renderFixture({ state }), styles);
        assert.equal(await section.count(), 1);
        const text = (await section.textContent()) ?? "";
        assert.match(text, expected);
        assert.doesNotMatch(text, /Pull me in|no.show/i);
        assert.equal(
          await section.locator("a, button, form, script, [tabindex], [aria-live]").count(),
          0,
        );
        assert.equal(
          await section.locator('[aria-current="step"]').count(),
          Number(state === "upcoming" || state === "frozen"),
        );
        if (state === "cancelled") assert.equal(await section.getByRole("listitem").count(), 4);
        if (state === "ended") assert.doesNotMatch(text, /Echo frozen/);
        assert.ok(await section.evaluate((el) => el.scrollWidth <= el.clientWidth));
        assert.ok(
          await section.evaluate((el, compact) => {
            const head = document.querySelector(".event-layout-head");
            const rail = document.querySelector(".event-layout-rail");
            const follows = (node) =>
              Boolean(node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (!el.closest(".event-layout-body") || !follows(head) || !follows(rail)) return false;
            const bounds = el.getBoundingClientRect();
            const railBounds = rail.getBoundingClientRect();
            return compact
              ? bounds.top >= Math.max(head.getBoundingClientRect().bottom, railBounds.bottom)
              : bounds.right <= railBounds.left && getComputedStyle(rail).position === "sticky";
          }, compact),
          `${state} at ${width}px: Lifeline must follow the header and rail in DOM and fit the layout`,
        );
        if (state === "upcoming") assert.deepEqual(await existingControls(page), before);
        await capture(state);
      }
      assert.ok((await page.consoleMessages()).every((message) => message.type() !== "error"));
      await openFixture(page, renderFixture({ state: "upcoming" }), styles);
      const going = compact
        ? page.getByRole("complementary", { name: "Your seat" }).locator('button[value="going"]')
        : page.getByTestId("rsvp-going");
      const submit = page.waitForRequest((request) => request.method() === "POST");
      await going.focus();
      await going.press("Enter");
      const request = await submit;
      assert.equal(request.url(), `${origin}${path}/rsvp`);
      assert.equal(request.postData(), "status=going");
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openFixture(page, renderFixture({ state: "upcoming" }), styles, true);
    const enhanced = page.waitForRequest((request) => request.method() === "PUT");
    await page.getByTestId("rsvp-going").press("Enter");
    const request = await enhanced;
    assert.equal(request.url(), `${origin}/events/fixture-raid/rsvp`);
    assert.deepEqual(request.postDataJSON(), { status: "going" });
    const confirmed = page.getByTestId("rsvp-confirmed");
    await confirmed.waitFor();
    assert.ok(await confirmed.evaluate((el) => el === document.activeElement));
  } finally {
    await browser.close();
  }
});
