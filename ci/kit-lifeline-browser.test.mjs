import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { chromium } from "playwright";
import { compileKitFixture, listenOnLoopback } from "./kit-hydration-harness.mjs";

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const eventKey = "fixture-raid";
const path = `/e/${eventKey}`;
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

function stubRequests(page, origin, enhanced = false) {
  return page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === path || url.pathname === `${path}/rsvp`) return route.continue();
    if (enhanced && url.pathname === "/events/fixture-raid/rsvp" && request.method() === "PUT") {
      return route.fulfill({ json: { data: { status: "going" } } });
    }
    const asset = publicAssets.has(url.pathname);
    const rsvpIsland = enhanced && url.pathname === "/islands/rsvp-button.js";
    if (asset || rsvpIsland) return route.fulfill({ path: file(`public${url.pathname}`) });
    return route.fulfill({ status: 204 });
  });
}

function existingControls(page) {
  return page
    .locator(".event-layout-head, .event-layout-rail, .event-seat-bar, script[src]")
    .evaluateAll((elements) => elements.map((el) => el.outerHTML));
}

// Expected clock (empty for an untimed plan) | actor and state | title | optional detail.
const opened = "18:00|Bot · Recorded|Sign-ups opened";
const seat = "18:23|You, on this site · Recorded|Your seat is saved";
const plannedSeat = "|Site · Planned|Save a seat while sign-ups are open";
const reminder = "19:32|Site · Recorded|Reminder results recorded|8 sent · 2 unavailable";
const waitingRoom = "20:00|Bot · Waiting|Room opens|Waiting on the bot.";
const ended = `${opened}\n${reminder}\n${waitingRoom}\n21:15|Bot · Recorded|Counting window closed`;
const examples = {
  upcoming: `${opened}\n${plannedSeat}\n19:30|Site · Next|Reminder ping\n19:45|Bot · Planned|Bot counts who’s in\n20:00|Bot · Planned|Room opens\n21:25|Site · Planned|Echo freezes`,
  frozen: `${opened}\n${reminder}\n19:45|Bot · Counting now|Bot counts who’s in\n${waitingRoom} Last synced 12 min ago\n21:25|Site · Next|Echo freezes`,
  cancelled: `${opened}\n${seat}\n20:00|Bot · Recorded|Event room seen\n20:01|Bot · Recorded|Event cancelled|The host cancelled because of severe weather.`,
  ended: `${ended}\n21:25|Site · Waiting|Echo freezes|Waiting on the site.`,
  "ended-recorded": `${ended}\n21:41|Site · Recorded|Echo frozen|2 attended · peak 5 in voice`,
};

async function attendanceExamples() {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { signedAttendanceReader } from './src/bot/attendance-read.ts';
        export { readEventDetailEcho } from './src/events/event-detail-echo.ts';
      `,
      resolveDir: file("."),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  const source = Buffer.from(outputFiles[0].text).toString("base64");
  const { signedAttendanceReader, readEventDetailEcho } = await import(
    `data:text/javascript;base64,${source}`
  );
  const contract = JSON.parse(
    readFileSync(file("test/fixtures/bot-site-contract-v2.json"), "utf8"),
  );
  const { results } = contract.verbs["event.attendance.read"];
  const event = { id: 7, eventKey, status: "past", endsAt: new Date("2026-11-21T21:00:00Z") };
  const attendance = {
    ...results.read,
    event_key: eventKey,
    window: { starts_at: "2026-11-21T19:45:00Z", ends_at: "2026-11-21T21:15:00Z" },
  };
  const config = {
    baseUrl: "https://bot.example.test",
    keyId: "lifeline-fixture",
    secret: randomBytes(32).toString("hex"),
  };
  const read = (fixtureResponse) =>
    readEventDetailEcho(
      event,
      signedAttendanceReader(config, async () => fixtureResponse),
      Date.parse("2026-11-21T21:41:00Z"),
    );
  const suppressedMessage = "Private fixture response";
  const [final, pending, suppressed] = await Promise.all([
    read(Response.json({ ok: true, result: attendance })),
    read(Response.json({ ok: true, result: { ...attendance, final: false } })),
    read(
      Response.json(
        { ok: false, error: { code: results.not_found.outcome, message: suppressedMessage } },
        { status: 404 },
      ),
    ),
  ]);
  const privateValues = [
    suppressedMessage,
    ...attendance.rooms.flatMap((room) => [room.channel_id, room.name_at_close]),
    ...attendance.members.flatMap((member) => [member.discord_id, member.first_joined_at]),
  ].filter((value) => typeof value === "string");
  return { final, pending, suppressed, privateValues };
}

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

async function assertNowLine(page, open, capture, compact) {
  const line = page.getByRole("region", { name: "Now Line" });
  const fixture = { state: "frozen", showLifeline: false };
  const observation = line.locator("p.observation");
  const marker = line.locator("svg[aria-hidden=true] .marker");
  const publicText = new Map();

  for (const member of [false, true]) {
    const audience = member ? "member" : "guest";
    const show = (nowLineCase, state = fixture.state) =>
      open(page, { ...fixture, state, nowLineCase, nowLineMember: member });
    await show("before");
    assert.equal(await line.count(), 0);
    const before = await existingControls(page);
    await capture(`now-line-before-${audience}`);

    for (const state of ["current", "stale"]) {
      const response = await show(state);
      assert.equal(await line.count(), 1);
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
      assert.deepEqual(await existingControls(page), before);
      assert.doesNotMatch(
        await response.text(),
        /Fixture player|Fixture attendee|kit-public-voice/,
      );
      assert.equal(
        await line.locator("a, button, form, script, [tabindex], [aria-live]").count(),
        0,
      );
      assert.match(await line.innerText(), /Schedule snapshot · Europe\/London/);
      assert.equal(
        await observation.innerText(),
        `${state === "stale" ? "Last seen" : "Now · as of"} 20:12`,
      );
      assert.deepEqual(
        await line.locator("time").evaluateAll((nodes) => nodes.map((node) => node.dateTime)),
        ["20:12", "20:00", "21:00"].map((clock) => `2026-11-21T${clock}:00.000Z`),
      );
      assert.equal(await marker.getAttribute("x1"), "20");
      assert.equal(await marker.getAttribute("x2"), "20");
      assert.equal(
        await marker.evaluate((el) => getComputedStyle(el).strokeDasharray !== "none"),
        state === "stale",
      );
      if (member) assert.equal(await line.innerText(), publicText.get(state));
      else publicText.set(state, await line.innerText());

      assert.ok(
        await line.evaluate((el, compact) => {
          const rail = document.querySelector(".event-layout-rail");
          const box = el.getBoundingClientRect();
          const railBox = rail.getBoundingClientRect();
          return (
            el.closest(".event-layout-body") &&
            (rail.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            (compact ? box.top >= railBox.bottom : box.right <= railBox.left)
          );
        }, compact),
      );
      const { violations } = await new AxeBuilder({ page }).include(".now-line").analyze();
      assert.deepEqual(
        violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
        [],
      );
      await capture(`now-line-${state}-${audience}`);
    }

    await show("absent");
    assert.equal(await line.count(), 0);
    assert.deepEqual(await existingControls(page), before);
    await capture(`now-line-absent-${audience}`);
    await show("invalid");
    assert.equal(await line.count(), 0);
    for (const state of ["cancelled", "ended"]) {
      await show("current", state);
      assert.equal(await line.count(), 0);
    }
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
  const attendance = await attendanceExamples();
  const sharedHeader = readFileSync(file("web/src/lib/site-header.css"), "utf8");
  const styles = `${css.build(new Scanner({ sources: css.sources }).scan())}\n${sharedHeader}\n${scoped}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  let props;
  const server = await listenOnLoopback((req, res) => {
    if (req.method === "POST" && req.url === `${path}/rsvp?attendees=2`) {
      return res.writeHead(303, { location: eventPath }).end();
    }
    const attendeePage = req.url === path ? 1 : req.url === eventPath ? 2 : null;
    if (req.method !== "GET" || attendeePage === null) return res.writeHead(404).end();
    const { body, head } = renderFixture({ ...props, attendeePage });
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>${styles}</style></head><body>${body}</body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  t.after(server.close);
  const origin = server.url;
  const open = (page, fixtureProps) => {
    props = fixtureProps;
    return page.goto(`${origin}${eventPath}`);
  };
  for (const width of [1280, 390]) {
    const compact = width === 390;
    const viewport = { width, height: compact ? 844 : 800 };
    const page = await browser.newPage({ viewport, javaScriptEnabled: false });
    await stubRequests(page, origin);
    const section = page.getByRole("region", { name: "Lifeline" });
    const capture = async (state) => {
      const context = `${state} at ${width}px`;
      assert.ok(
        await page.locator("html").evaluate((el) => el.scrollWidth <= el.clientWidth),
        context,
      );
      const panel = page.locator("#kit-menu-panel");
      if (compact)
        assert.equal(await panel.evaluate((el) => getComputedStyle(el).display), "none", context);
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
      const response = await open(
        page,
        state === "ended-recorded" ? { state: "ended", echo: attendance.final } : { state },
      );
      assert.equal(await section.count(), 1);
      await assertRows(section, expected, state, width);
      assert.doesNotMatch((await section.textContent()) ?? "", /Pull me in|no.show/i);
      const controls = section.locator("a, button, form, script, [tabindex], [aria-live]");
      assert.equal(await controls.count(), 0);
      const ongoing = state === "upcoming" || state === "frozen";
      assert.equal(await section.locator('[aria-current="step"]').count(), Number(ongoing));
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
        assert.match(await signupRecord.innerText(), /8 listed sign-ups/);
        const html = await response.text();
        for (const value of attendance.privateValues) assert.ok(!html.includes(value));
      }
      await capture(state);
    }
    for (const [state, echo] of [
      ["provisional", attendance.pending],
      ["privacy-suppressed", attendance.suppressed],
    ]) {
      assert.equal(echo, undefined, state);
      const response = await open(page, { state: "ended", echo });
      await assertRows(section, examples.ended, state, width);
      const html = await response.text();
      assert.doesNotMatch(html, /2 attended|peak 5 in voice/);
      for (const value of attendance.privateValues) assert.ok(!html.includes(value));
      await capture(state);
    }
    await assertNowLine(page, open, capture, compact);
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
    const currentPage = page.getByTestId("event-attendees-current-page");
    assert.equal(await currentPage.innerText(), "Page 2");
    await page.getByTestId("event-attendees-prev").click();
    assert.equal(await currentPage.innerText(), "Page 1");
    await page.getByTestId("event-attendees-next").click();
    assert.equal(await currentPage.innerText(), "Page 2");
    await open(page, { state: "upcoming", savedSeat: true });
    await assertRows(section, examples.upcoming.replace(plannedSeat, seat), "saved seat", width);
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await stubRequests(page, origin, true);
  await open(page, { state: "upcoming" });
  const enhanced = page.waitForRequest((request) => request.method() === "PUT");
  await page.getByTestId("rsvp-going").press("Enter");
  const request = await enhanced;
  assert.equal(request.url(), `${origin}/events/fixture-raid/rsvp`);
  assert.deepEqual(request.postDataJSON(), { status: "going" });
  const confirmed = page.getByTestId("rsvp-confirmed");
  await confirmed.waitFor();
  assert.ok(await confirmed.evaluate((el) => el === document.activeElement));
});
