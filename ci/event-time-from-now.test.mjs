// Unconditional browser acceptance: node --import tsx --test ci/event-time-from-now.test.mjs
// No opt-in/skip or simulated GREEN when Chromium is unavailable. The Builder
// registers this in browser-capable CI, not the Chromium-free root unit job.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { scheduleCases } from "../test/fixtures/event-scheduled-range.ts";
import {
  timeFromNowCases,
  timeFromNowIds as ids,
  timeFromNowServerTime as serverTime,
  timeFromNowWindow as window,
} from "../test/fixtures/event-time-from-now.ts";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduledEvent,
  scheduleOrigin,
  schedulePath,
} from "../test/helpers/event-scheduled-range.ts";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url)).replace(/\/$/, "");
const buttonSelector = `[data-testid="${ids.button}"]`;
const statusSelector = `[data-testid="${ids.status}"]`;
// Existing RSVP, attendance and copy features have their own effects/contracts.
// Execute the device-zone island and every other detail island, allowing either
// an added time island or integration into event-device-timezone.js. All bytes
// come from the real renderer's script tags and checked-in public/, not assets/.
const unrelated = new Set([
  "rsvp-button.js",
  "copy-link.js",
  "going-count.js",
  "attendees-live.js",
  "auth-status.js",
  "model-context.js",
  "join-return.js",
  "return-journey.js",
]);
let browser;
let kit;
before(async () => {
  kit = await compileScheduleKit();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function open(t, twin, options = {}) {
  const spec = { ...window, now: "2030-03-10T09:00:00.000Z", ...options };
  const row = scheduledEvent(scheduleCases[0], {
    startsAt: new Date(spec.startsAt),
    endsAt: new Date(spec.endsAt),
    timezone: spec.timezone,
    status: spec.status ?? "published",
  });
  const rendered = await renderScheduledPage(
    twin,
    row,
    spec.viewer ?? "member",
    kit,
    spec.serverTime ?? serverTime,
  );
  assert.equal(
    rendered.status,
    spec.status === "cancelled" ? 410 : 200,
    "U2_FIXTURE_ROUTE: reach the real route/model",
  );
  const scripts = [...rendered.html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)]
    .map((match) => match[1])
    .filter((src) => src.startsWith("/islands/") && !unrelated.has(src.split("/").at(-1)));
  if (spec.status !== "cancelled")
    assert.ok(
      scripts.includes("/islands/event-device-timezone.js"),
      "U2_FIXTURE_DEVICE_ZONE: real mount still wires the existing island",
    );
  // Keep structured data; the route handler below aborts every /islands/
  // fetch so no renderer script runs except the islands this test injects
  // itself via addScriptTag. No rewritten HTML copy: serve rendered.html
  // unchanged (plus Kit CSS) so JSON-LD stays verbatim.
  let html = rendered.html;
  if (kit.css) html = html.replace("</head>", `<style>${kit.css}</style></head>`);
  if (spec.corrupt) {
    html = html.replaceAll(spec.corrupt[0], spec.corrupt[1]);
    // Poison a numeric duplicate too, if the enhancement transports epoch ms.
    const replacement = Date.parse(spec.corrupt[1]);
    html = html.replaceAll(
      String(Date.parse(spec.corrupt[0])),
      Number.isFinite(replacement) ? String(replacement) : spec.corrupt[1],
    );
  }
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: spec.deviceZone ?? "America/Los_Angeles",
    javaScriptEnabled: spec.javaScriptEnabled !== false,
    serviceWorkers: "block",
  });
  t.after(async () => {
    await context.close();
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let enhanced = false;
  page.on("request", (request) => {
    if (enhanced) requests.push(request.url());
  });
  if (spec.javaScriptEnabled !== false) {
    // install() alone ticks in real time. Pause at the literal instant before
    // navigation so the +/-1 ms boundary cases and checked-at equality are real.
    await page.clock.install({ time: new Date(Date.parse(spec.now) - 60_000) });
    await page.clock.pauseAt(new Date(spec.now));
    await page.addInitScript((failure) => {
      const effects = [];
      window.__u2Effects = effects;
      const forbid = (name) => () => {
        effects.push(name);
        throw new Error(`U2_FORBIDDEN_EFFECT: ${name}`);
      };
      for (const name of [
        "fetch",
        "setInterval",
        "setTimeout",
        "requestAnimationFrame",
        "requestIdleCallback",
        "WebSocket",
        "EventSource",
        "Worker",
        "SharedWorker",
      ]) {
        window[name] = forbid(name);
      }
      XMLHttpRequest.prototype.open = forbid("xhr");
      navigator.sendBeacon = forbid("beacon");
      for (const name of ["getItem", "setItem", "removeItem", "clear"])
        Storage.prototype[name] = forbid(`storage.${name}`);
      for (const name of ["pushState", "replaceState"]) history[name] = forbid(`history.${name}`);
      Object.defineProperty(document, "cookie", {
        get: forbid("cookie.read"),
        set: forbid("cookie.write"),
      });
      if (window.indexedDB) {
        indexedDB.open = forbid("indexeddb.open");
        indexedDB.deleteDatabase = forbid("indexeddb.delete");
      }
      if (window.Notification) {
        Notification.requestPermission = forbid("notification");
        window.Notification = forbid("notification-constructor");
      }
      if (window.Cache)
        for (const name of ["match", "put", "add", "addAll", "delete"])
          Cache.prototype[name] = forbid(`cache.${name}`);
      if (navigator.serviceWorker) navigator.serviceWorker.register = forbid("service-worker");
      const NativeDate = Date;
      window.__u2ClockReads = 0;
      window.Date = new Proxy(NativeDate, {
        construct(target, args) {
          if (!args.length) window.__u2ClockReads++;
          return Reflect.construct(
            target,
            !args.length && failure === "invalid-clock" ? [Number.NaN] : args,
          );
        },
        apply(target, receiver, args) {
          window.__u2ClockReads++;
          return failure === "invalid-clock"
            ? "Invalid Date"
            : Reflect.apply(target, receiver, args);
        },
        get(target, key) {
          if (key !== "now") return Reflect.get(target, key);
          return () => {
            window.__u2ClockReads++;
            return failure === "invalid-clock" ? Number.NaN : NativeDate.now();
          };
        },
      });
      if (failure === "missing-date") Object.defineProperty(window, "Date", { value: undefined });
      if (failure === "missing-intl") Object.defineProperty(window, "Intl", { value: undefined });
    }, spec.failure);
  }
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === scheduleOrigin && url.pathname === schedulePath) {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    // Suppress the renderer's executable island fetches; the test injects the
    // chosen island bytes itself via addScriptTag after navigation.
    if (url.origin === scheduleOrigin && url.pathname.startsWith("/islands/")) {
      await route.abort();
      return;
    }
    const file = resolve(publicRoot, `.${url.pathname}`);
    if (url.origin === scheduleOrigin && file.startsWith(publicRoot + sep)) {
      try {
        await route.fulfill({
          body: readFileSync(file),
          contentType: file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream",
        });
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await route.abort();
  });
  await page.goto(scheduleOrigin + schedulePath);
  enhanced = true;
  if (spec.javaScriptEnabled !== false) {
    for (const src of scripts)
      await page.addScriptTag({
        content: readFileSync(new URL(`../public${src}`, import.meta.url), "utf8"),
      });
  }
  return { page, errors, requests, html: rendered.html };
}

async function quiet(opened) {
  assert.deepEqual(opened.errors, [], "U2_SCRIPT_ERROR: enhancement must fail harmlessly");
  assert.deepEqual(opened.requests, [], "U2_NETWORK: no request after enhancement starts");
  assert.deepEqual(
    await opened.page.evaluate(() => window.__u2Effects),
    [],
    "U2_SIDE_EFFECT: no timers, persistence, notifications or cache access",
  );
}
async function activate(page, key = "Enter") {
  const button = page.locator(buttonSelector);
  assert.equal(
    await button.count(),
    1,
    "U2_ACTION_MISSING: mount one explicit time-from-now action",
  );
  assert.equal(
    await button.isVisible(),
    true,
    "U2_ACTION_UNAVAILABLE: reveal only a usable enhancement",
  );
  assert.equal(
    await button.getAttribute("type"),
    "button",
    "U2_INFORMATIONAL: never submit an RSVP form",
  );
  assert.match(
    await button.innerText(),
    /time|how long|until/i,
    "U2_ACCESSIBLE_NAME: explain the action",
  );
  await button.focus();
  await page.keyboard.press(key);
  assert.equal(
    await button.evaluate((node) => document.activeElement === node),
    true,
    "U2_FOCUS: keep focus on the requested action",
  );
  const status = page.locator(statusSelector);
  assert.equal(await status.count(), 1, "U2_STATUS_MISSING: provide one result");
  assert.equal(await status.getAttribute("role"), "status");
  assert.equal(await status.getAttribute("aria-live"), "polite");
  const text = (await status.innerText()).replace(/\s+/g, " ").trim();
  assert.ok(
    text.length > 0 && text.length <= 512,
    "U2_BOUNDED_RESULT: nonempty result, at most 512 characters",
  );
  assert.doesNotMatch(
    text,
    /NaN|Infinity|Invalid Date|-\d+\s*(?:minute|hour|day)s?\b|live countdown|updates? automatically/i,
  );
  return { status, text };
}
async function checkedAt(status, now) {
  assert.match(
    await status.innerText(),
    /checked at/i,
    "U2_CHECKED_AT_LABEL: not a live countdown",
  );
  const instant = status.locator("time[datetime]");
  assert.equal(
    await instant.count(),
    1,
    "U2_CHECKED_AT_INSTANT: one machine-readable checked-at time",
  );
  assert.equal(
    Date.parse(await instant.getAttribute("datetime")),
    Date.parse(now),
    "U2_CHECKED_AT_WRONG: label the activation's device-clock instant",
  );
  assert.ok(
    (await instant.innerText()).trim().length > 0,
    "U2_CHECKED_AT_VISIBLE: do not hide the actual check time",
  );
}
async function authority(page) {
  return page.evaluate(() => ({
    absolute: [...document.querySelectorAll(".event-meta > div")]
      .filter((node) => /^(Starts|Ends)$/.test(node.querySelector("dt")?.textContent?.trim() ?? ""))
      .map((node) => node.querySelector("time[datetime]")?.outerHTML),
    forms: [...document.querySelectorAll("form")].map((node) => node.outerHTML),
    rsvp: document.querySelector('[data-island="rsvp-button"]')?.outerHTML,
    seo: [
      ...document.querySelectorAll(
        'head meta,head link[rel="canonical"],script[type="application/ld+json"]',
      ),
    ].map((node) => node.outerHTML),
    calendar: [
      ...document.querySelectorAll(
        '[data-testid="event-ics"],[data-testid="event-google-calendar"],[data-testid="event-copy-link"]',
      ),
    ].map((node) => node.outerHTML),
  }));
}

for (const twin of ["Hono", "Kit"]) {
  describe(`${twin} time-from-now browser acceptance`, () => {
    for (const spec of timeFromNowCases) {
      it(spec.name, async (t) => {
        const opened = await open(t, twin, spec);
        const before = await authority(opened.page);
        const { status, text } = await activate(opened.page);
        assert.match(text, spec.state, "U2_STATE: classify the exact boundary truthfully");
        for (const distance of spec.distances)
          assert.match(
            text,
            distance,
            "U2_DISTANCE: use bounded elapsed durations, not wall-clock subtraction",
          );
        assert.doesNotMatch(text, /(?:starts?|ends?) in 0\b/i);
        if (/ended|finished/i.test(text)) assert.doesNotMatch(text, /(?:starts?|ends?) in\b/i);
        if (/underway|in progress|has started/i.test(text))
          assert.doesNotMatch(text, /starts? in\b/i);
        await checkedAt(status, spec.now);
        const repeated = await activate(opened.page, "Space");
        assert.equal(repeated.text, text, "U2_ROUNDING: same clock yields the same result");
        assert.deepEqual(
          await authority(opened.page),
          before,
          "U2_AUTHORITY: never change schedule/RSVP/SEO from the device clock",
        );
        await quiet(opened);
      });
    }

    it("U2.2/U2.4 explicit activation only; frozen result until another activation", async (t) => {
      const opened = await open(t, twin);
      const { page } = opened;
      assert.equal(await page.locator(buttonSelector).count(), 1, "U2_ACTION_MISSING");
      assert.equal(
        (await page.locator(statusSelector).innerText()).trim(),
        "",
        "U2_PASSIVE: do not announce unrequested relative time",
      );
      await page.clock.fastForward(60_000);
      assert.equal((await page.locator(statusSelector).innerText()).trim(), "");
      assert.equal(await page.evaluate(() => window.__u2ClockReads), 0, "U2_NO_PASSIVE_CLOCK_READ");
      const first = await activate(page);
      await checkedAt(first.status, "2030-03-10T09:01:00.000Z");
      assert.equal(
        await page.evaluate(() => window.__u2ClockReads),
        1,
        "U2_ONE_CHECK_INSTANT: sample once per request",
      );
      await page.clock.fastForward(2 * 3600_000);
      assert.equal(await page.evaluate(() => window.__u2ClockReads), 1);
      assert.equal(
        (await first.status.innerText()).replace(/\s+/g, " ").trim(),
        first.text,
        "U2_NO_COUNTDOWN: passive time cannot change the checked result",
      );
      const second = await activate(page);
      assert.equal(await page.evaluate(() => window.__u2ClockReads), 2, "U2_ONE_CHECK_INSTANT");
      assert.match(second.text, /ended|has finished/i);
      await checkedAt(second.status, "2030-03-10T11:01:00.000Z");
      assert.notEqual(
        second.text,
        first.text,
        "U2_RECOMPUTE: a new request must read the current clock",
      );
      await quiet(opened);
    });

    it("U2.5 keyboard Tab reaches the action; Enter and Space retain focus", async (t) => {
      const opened = await open(t, twin);
      const { page } = opened;
      assert.equal(await page.locator(buttonSelector).count(), 1, "U2_ACTION_MISSING");
      let reached = false;
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press("Tab");
        reached = await page
          .locator(buttonSelector)
          .evaluate((node) => document.activeElement === node);
        if (reached) break;
      }
      assert.equal(reached, true, "U2_KEYBOARD: action must be in the ordinary tab order");
      await page.keyboard.press("Enter");
      assert.ok((await page.locator(statusSelector).innerText()).trim());
      assert.equal(
        await page.locator(buttonSelector).evaluate((node) => document.activeElement === node),
        true,
      );
      await activate(page, "Space");
      await quiet(opened);
    });

    it("U2.6 device-zone formatting remains separate from time distance", async (t) => {
      const opened = await open(t, twin, { deviceZone: "Asia/Tokyo" });
      const initial = await authority(opened.page);
      const first = await activate(opened.page);
      for (const endpoint of ["starts", "ends"]) {
        const button = opened.page.getByTestId(`event-device-timezone-${endpoint}-button`);
        assert.equal(await button.isVisible(), true);
        await button.click();
        assert.match(
          await opened.page.getByTestId(`event-device-timezone-${endpoint}-status`).innerText(),
          /Tokyo/,
        );
      }
      assert.equal((await activate(opened.page)).text, first.text);
      assert.deepEqual(await authority(opened.page), initial);
      await quiet(opened);
    });

    it("U2.6 a slow device clock cannot reopen server-closed RSVP", async (t) => {
      const opened = await open(t, twin, {
        now: "2030-03-10T09:00:00.000Z",
        serverTime: new Date("2030-03-11T00:00:00.000Z"),
      });
      assert.equal(await opened.page.getByTestId("rsvp-going").count(), 0);
      assert.equal(await opened.page.getByTestId("rsvp-closed").count(), 1);
      const before = await authority(opened.page);
      await activate(opened.page);
      assert.deepEqual(await authority(opened.page), before);
      await quiet(opened);
    });

    it("CONTROL U2.5/U2.6 no-JS keeps absolute times and RSVP, no dead enhancement", async (t) => {
      const opened = await open(t, twin, { javaScriptEnabled: false });
      for (const instant of [window.startsAt, window.endsAt]) {
        assert.equal(await opened.page.locator(`time[datetime="${instant}"]`).count(), 1);
      }
      assert.equal(await opened.page.getByTestId("rsvp-going").isVisible(), true);
      assert.equal(await opened.page.locator(buttonSelector).isVisible(), false);
      const status = opened.page.locator(statusSelector);
      if (await status.count()) assert.equal((await status.innerText()).trim(), "");
      assert.deepEqual(opened.errors, []);
    });

    for (const failure of ["missing-date", "missing-intl", "invalid-clock"]) {
      it(`CONTROL U2.5/U2.8 ${failure} remains harmless`, async (t) => {
        const opened = await open(t, twin, { failure });
        const button = opened.page.locator(buttonSelector);
        if ((await button.isVisible()) && !(await button.isDisabled())) {
          const result = await activate(opened.page);
          // Intl is optional if the implementation can truthfully use UTC.
          if (failure !== "missing-intl")
            assert.match(result.text, /unavailable|cannot|could not|unable|invalid/i);
        }
        assert.equal(await opened.page.getByTestId("rsvp-going").isVisible(), true);
        await quiet(opened);
      });
    }

    for (const [name, corrupt] of [
      ["invalid start", [window.startsAt, "not-an-instant"]],
      ["invalid end", [window.endsAt, "not-an-instant"]],
      ["non-finite instant", [window.startsAt, "Infinity"]],
      ["reversed window", [window.endsAt, "2030-03-10T08:30:00.000Z"]],
    ]) {
      it(`U2.8 ${name}: no false countdown, exception or unbounded result`, async (t) => {
        const opened = await open(t, twin, { corrupt });
        const button = opened.page.locator(buttonSelector);
        // Require a real server mount, not a synthetic test node. A binder may
        // remove or hide the unusable action after rejecting the corrupt input.
        assert.ok(opened.html.includes(`data-testid="${ids.button}"`), "U2_ACTION_MISSING");
        if ((await button.isVisible()) && !(await button.isDisabled())) {
          const { text } = await activate(opened.page);
          assert.match(
            text,
            /unavailable|cannot|could not|unable|invalid/i,
            "U2_INVALID_INSTANT: do not invent a duration",
          );
          assert.doesNotMatch(text, /(?:starts?|ends?) in \d/i);
        }
        await quiet(opened);
      });
    }

    it("U2.8 extreme finite instants still produce a finite bounded explanation", async (t) => {
      const opened = await open(t, twin, {
        startsAt: "+275760-09-12T00:00:00.000Z",
        endsAt: "+275760-09-13T00:00:00.000Z",
      });
      const { text } = await activate(opened.page);
      assert.match(text, /starts? in|future|unavailable|unable|cannot/i);
      await quiet(opened);
    });

    for (const status of ["draft", "cancelled"]) {
      it(`CONTROL U2.7 ${status} is never advertised as an upcoming game night`, async (t) => {
        const opened = await open(t, twin, {
          status,
          viewer: status === "draft" ? "moderator" : "guest",
        });
        const button = opened.page.locator(buttonSelector);
        if ((await button.isVisible()) && !(await button.isDisabled())) {
          const { text } = await activate(opened.page);
          assert.match(text, new RegExp(status, "i"));
          assert.doesNotMatch(text, /(?:starts?|ends?) in \d/i);
        }
        assert.equal(await opened.page.getByTestId("rsvp-going").count(), 0);
        await quiet(opened);
      });
    }
  });
}
