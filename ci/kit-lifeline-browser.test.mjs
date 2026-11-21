import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compileKitFixture, listenOnLoopback } from "./kit-hydration-harness.mjs";

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const path = "/e/fixture-raid";
const eventPath = `${path}?attendees=2`;
const publicAssets = new Set([
  "/styles.css",
  "/theme.css",
  "/event-theme.css",
  "/logo.svg",
  "/fonts/mona-sans-latin-wght.woff2",
  "/fonts/fragment-mono-latin-400.woff2",
  "/fonts/instrument-serif-latin-400-italic.woff2",
]);

async function openFixture(page, origin, enhanced = false) {
  await page.unrouteAll();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === path && request.method() === "GET") return route.continue();
    if (publicAssets.has(url.pathname))
      return route.fulfill({ path: file(`public${url.pathname}`) });
    if (url.pathname === `${path}/rsvp` && request.method() === "POST") {
      return route.fulfill({ status: 303, headers: { location: `${path}${url.search}` } });
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
  await page.goto(`${origin}${eventPath}`);
}

function existingControls(page) {
  return page
    .locator(".event-layout-head, .event-layout-rail, .event-seat-bar, script[src]")
    .evaluateAll((elements) => elements.map((el) => el.outerHTML));
}

// Expected clock (empty for an untimed plan) | actor and state | title | optional detail.
const opened = "18:00|Bot · Recorded|Sign-ups opened";
const seat = "18:23|You, on this site · Recorded|Your seat is saved";
const reminder = "19:32|Site · Recorded|Reminder results recorded|8 sent · 2 unavailable";
const waitingRoom = "20:00|Bot · Waiting|Room opens|Waiting on the bot.";
const ended = `${opened}\n${reminder}\n${waitingRoom}\n21:15|Bot · Recorded|Counting window closed`;
const examples = {
  upcoming: `${opened}\n|Site · Planned|Save a seat while sign-ups are open\n19:30|Site · Next|Reminder ping\n19:45|Bot · Planned|Bot counts who’s in\n20:00|Bot · Planned|Room opens\n21:25|Site · Planned|Echo freezes`,
  frozen: `${opened}\n${reminder}\n19:45|Bot · Counting now|Bot counts who’s in\n${waitingRoom} Last synced 12 min ago\n21:25|Site · Next|Echo freezes`,
  cancelled: `${opened}\n${seat}\n20:00|Bot · Recorded|Event room seen\n20:01|Bot · Recorded|Event cancelled|The host cancelled because of severe weather.`,
  ended: `${ended}\n21:25|Site · Waiting|Echo freezes|Waiting on the site.`,
  "ended-recorded": `${ended}\n21:41|Site · Recorded|Echo frozen`,
};

async function assertRows(section, expected, state, width) {
  const rows = await section.locator("ol > li").all();
  const labels = expected.split("\n");
  assert.equal(rows.length, labels.length, `${state}: row count`);
  for (const [index, row] of rows.entries()) {
    const [clock, meta, title, detail] = labels[index].split("|");
    const context = `${state}: ${title} at ${width}px`;
    const readLabel = (label) => row.locator(`${label}:visible`).allTextContents();
    const copy = await Promise.all([".meta", ".title", ".detail"].map(readLabel));
    assert.deepEqual(copy, [[meta], [title], detail ? [detail] : []], context);
    if (!clock) {
      assert.equal(await row.locator("time").count(), 0, context);
      continue;
    }
    const stamp = row.locator(`time[datetime="2026-11-21T${clock}:00.000Z"]:visible`, {
      hasText: `${clock} Europe/London`,
    });
    const time = (await stamp.isVisible()) ? await stamp.boundingBox() : null;
    const entry = await row.locator(".entry:visible").boundingBox();
    assert.ok(time && entry, `${context}: visible timestamp and entry bounds`);
    const above = time.y + time.height <= entry.y;
    const aligned = time.y >= entry.y && time.y < entry.y + entry.height;
    assert.ok(width === 390 ? above : aligned && time.x + time.width <= entry.x, context);
  }
}

test("EventDetail places the read-only Lifeline after the seat rail and preserves RSVP", async (t) => {
  const webRequire = createRequire(file("web/package.json"));
  const { compile } = webRequire("@tailwindcss/node");
  const { Scanner } = webRequire("@tailwindcss/oxide");
  const options = { base: file("web/src"), onDependency: () => {} };
  const css = await compile(readFileSync(file("web/src/app.css"), "utf8"), options);
  const fixture = file("test/fixtures/kit-lifeline.svelte");
  const { renderFixture, css: scoped } = await compileKitFixture({ fixture, ssrOnly: true });
  const sharedHeader = readFileSync(file("web/src/lib/site-header.css"), "utf8");
  const styles = `${css.build(new Scanner({ sources: css.sources }).scan())}\n${sharedHeader}\n${scoped}`;
  let html;
  // Chromium does not route the redirected GET through page.route().
  const server = await listenOnLoopback((req, res) => {
    if (req.method !== "GET" || req.url !== eventPath) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  t.after(server.close);
  const origin = server.url;
  const open = (page, props, enhanced) => {
    const { body, head } = renderFixture(props);
    html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>${styles}</style></head><body>${body}</body></html>`;
    return openFixture(page, origin, enhanced);
  };
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      const compact = width === 390;
      const viewport = { width, height: compact ? 844 : 800 };
      const page = await browser.newPage({ viewport, javaScriptEnabled: false });
      const section = page.getByRole("region", { name: "Lifeline" });
      const capture = async (state) => {
        const context = `${state} at ${width}px`;
        assert.ok(
          await page.locator("html").evaluate((el) => el.scrollWidth <= el.clientWidth),
          `${context}: page must fit the viewport`,
        );
        if (compact) {
          const panel = page.locator("#kit-menu-panel");
          assert.equal(await panel.evaluate((el) => getComputedStyle(el).display), "none", context);
        }
        await page.screenshot({
          path: `artifacts/kit-lifeline/${state}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      };
      await open(page, { state: "upcoming", showLifeline: false });
      assert.equal(await section.count(), 0);
      const before = await existingControls(page);
      await capture("before");
      const signupRecord = page.getByRole("region", { name: "Sign-up record" });
      await open(page, { state: "ended", showLifeline: false });
      assert.match(await signupRecord.innerText(), /No Echo for this one\./);

      for (const [state, expected] of Object.entries(examples)) {
        await open(page, { state });
        assert.equal(await section.count(), 1);
        await assertRows(section, expected, state, width);
        assert.doesNotMatch((await section.textContent()) ?? "", /Pull me in|no.show/i);
        assert.equal(
          await section.locator("a, button, form, script, [tabindex], [aria-live]").count(),
          0,
        );
        assert.equal(
          await section.locator('[aria-current="step"]').count(),
          Number(state === "upcoming" || state === "frozen"),
        );
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
        if (state === "ended" || state === "ended-recorded") {
          assert.doesNotMatch(await signupRecord.innerText(), /No Echo for this one\./);
        }
        await capture(state);
      }
      assert.ok((await page.consoleMessages()).every((message) => message.type() !== "error"));
      await open(page, { state: "upcoming" });
      const going = compact
        ? page.getByRole("complementary", { name: "Your seat" }).locator('button[value="going"]')
        : page.getByTestId("rsvp-going");
      await going.focus();
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.request().redirectedFrom()?.method() === "POST"),
        page.waitForEvent("domcontentloaded"),
        going.press("Enter"),
      ]);
      const request = response.request().redirectedFrom();
      assert.equal(request.url(), `${origin}${path}/rsvp?attendees=2`);
      assert.equal(request.postData(), "status=going");
      assert.equal((await request.response())?.status(), 303);
      assert.equal(response.url(), `${origin}${eventPath}`);
      assert.equal(response.status(), 200);
      assert.equal(await page.getByTestId("event-attendees-current-page").innerText(), "Page 2");
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await open(page, { state: "upcoming" }, true);
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
