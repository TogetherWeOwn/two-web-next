// Test-author owned, intentionally RED until the paired behavior exists.
// node --import tsx --test ci/event-native-share-browser.test.mjs
// No opt-in skips: Builder must register this command in browser-enabled CI
// with an executed-case verifier. The Hono a11y/Lighthouse gates do not cover Kit.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import {
  nativeShareFixture,
  PRIVATE_ID,
  PRIVATE_NAME,
  SHARE_CANONICAL,
  SHARE_KEY,
  SHARE_ORIGIN,
  SHARE_PATH,
  SHARE_QUERY,
  SHARE_TITLE,
  SHARE_VIEWS,
} from "../test/fixtures/event-native-share.ts";

let browser;
const evidence = process.env.EVENT_NATIVE_SHARE_EVIDENCE_DIR;
const ROOT = resolve("public");
const SHARE_NAME = /^share(?: this)?(?: event)?$/i;
const expectedPayload = { title: SHARE_TITLE, url: SHARE_CANONICAL };
before(async () => {
  browser = await chromium.launch({ headless: true });
  if (evidence) await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
});

// Only the native device boundary is replaced. The actual renderer's script tags
// load shipped public bytes; the fixture never invents an island or an action.
function stubDevice({ mode, clipboard }) {
  window.shareTrace = {
    calls: [],
    settlements: [],
    copied: [],
    permissionQueries: [],
    rejections: [],
  };
  window.addEventListener("unhandledrejection", (event) =>
    window.shareTrace.rejections.push(String(event.reason)),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value) => {
        window.shareTrace.copied.push(value);
        if (clipboard === "denied")
          throw new DOMException("Fixture clipboard refused", "NotAllowedError");
      },
    },
  });
  if (clipboard === "denied") document.execCommand = () => false;
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: async (descriptor) => {
        window.shareTrace.permissionQueries.push(descriptor);
        return { state: "prompt" };
      },
    },
  });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value:
      mode === "unsupported"
        ? undefined
        : function (payload) {
            window.shareTrace.calls.push({
              payload: JSON.parse(JSON.stringify(payload)),
              active: navigator.userActivation.isActive,
            });
            if (mode === "pending")
              return new Promise((resolve, reject) =>
                window.shareTrace.settlements.push({ resolve, reject }),
              );
            if (mode === "cancel")
              return Promise.reject(new DOMException("User cancelled", "AbortError"));
            if (mode === "failure")
              return Promise.reject(new DOMException("Fixture share refused", "NotAllowedError"));
            if (mode === "sync-failure") throw new TypeError("Fixture synchronous share failure");
            return Promise.resolve();
          },
  });
}

async function open(t, view, options = {}) {
  const {
    mode = "success",
    viewer = "guest",
    javaScriptEnabled = true,
    insecure = false,
    clipboard = "ok",
  } = options;
  const fixture = await nativeShareFixture(view, options);
  assert.equal(fixture.status, options.missing ? 404 : options.status === "cancelled" ? 410 : 200);
  const origin = insecure ? "http://events.example.test" : SHARE_ORIGIN;
  const context = await browser.newContext({
    javaScriptEnabled,
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
  });
  t.after(() => context.close());
  await context.addInitScript(stubDevice, { mode, clipboard });
  // A real HttpOnly cookie exists in the browser too; payload tests must not
  // silently compare two anonymous pages or merely omit private fixtures.
  if (viewer !== "guest")
    await context.addCookies([
      {
        name: "fixture-private-session",
        value: "private-cookie-context",
        url: SHARE_ORIGIN,
        httpOnly: true,
        secure: true,
      },
    ]);
  const blocked = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === SHARE_PATH) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture.html });
      return;
    }
    const file = resolve(ROOT, `.${url.pathname}`);
    if (url.origin === origin && file.startsWith(ROOT + sep)) {
      try {
        await route.fulfill({
          body: await readFile(file),
          contentType: file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".svg")
                ? "image/svg+xml"
                : "application/octet-stream",
        });
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    blocked.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto(origin + SHARE_PATH + SHARE_QUERY, { waitUntil: "load" });
  if (javaScriptEnabled) assert.equal(await page.evaluate(() => isSecureContext), !insecure);
  assert.equal(
    (await page.getByTestId("event-attendees").count()) > 0,
    viewer !== "guest" && fixture.status === 200,
  );
  if (viewer !== "guest" && fixture.status === 200)
    assert.match(await page.locator("body").innerText(), new RegExp(PRIVATE_NAME));
  const effects = [];
  page.on("request", (request) => effects.push(`${request.method()} ${request.url()}`));
  return { page, context, errors, dialogs, blocked, effects };
}
const nativeButton = (page) => page.getByRole("button", { name: SHARE_NAME });
async function readyButton(page) {
  const button = nativeButton(page);
  // Fail at the absent product affordance, never a 30-second missing-selector timeout.
  assert.equal(
    await button.count(),
    1,
    "missing visible, separate native Share button on supported secure event",
  );
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  assert.equal(await button.evaluate((node) => node.tagName), "BUTTON");
  assert.equal(await button.getAttribute("type"), "button");
  return button;
}
async function tabTo(page, locator) {
  for (let step = 0; step < 60; step++) {
    if (await locator.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  assert.fail("action not keyboard-reachable through ordinary Tab navigation");
}
async function trace(page) {
  return page.evaluate(() => ({
    calls: window.shareTrace.calls,
    copied: window.shareTrace.copied,
    permissionQueries: window.shareTrace.permissionQueries,
    rejections: window.shareTrace.rejections,
  }));
}
async function liveText(page) {
  return page.locator('[role="status"],[role="alert"],[aria-live]').allTextContents();
}
async function noEscapedEffects(fixture) {
  assert.deepEqual(fixture.errors, [], "no unhandled browser handler errors");
  assert.deepEqual(fixture.dialogs, [], "no custom permission prompts or alerts");
  assert.deepEqual(
    fixture.effects,
    [],
    "sharing must not navigate, post, fetch, or load an outbound integration",
  );
  assert.deepEqual(
    fixture.blocked,
    [],
    "fixture must not mask unimplemented assets or outbound requests",
  );
  const state = await trace(fixture.page);
  assert.deepEqual(state.permissionQueries, []);
  assert.deepEqual(state.rejections, []);
}
async function calendarAndCopy(page) {
  const copy = page.getByTestId("event-copy-link");
  await expect(copy).toBeVisible();
  assert.equal(await copy.getAttribute("href"), SHARE_CANONICAL);
  assert.equal(await copy.getAttribute("data-copy-link"), SHARE_CANONICAL);
  assert.equal(
    await page.getByTestId("event-ics").getAttribute("href"),
    `/events/${SHARE_KEY}.ics`,
  );
  assert.match(
    await page.getByTestId("event-google-calendar").getAttribute("href"),
    /^https:\/\/calendar\.google\.com\/calendar\/render\?/,
  );
}

for (const view of SHARE_VIEWS) {
  for (const viewer of ["guest", "member"]) {
    test(`${view}: CONTROL supported ${viewer} load never shares, prompts, copies, or steals focus`, async (t) => {
      const f = await open(t, view, { viewer });
      assert.deepEqual(await trace(f.page), {
        calls: [],
        copied: [],
        permissionQueries: [],
        rejections: [],
      });
      assert.equal(await f.page.evaluate(() => document.activeElement.tagName), "BODY");
      await calendarAndCopy(f.page);
      await noEscapedEffects(f);
    });
  }
  test(`${view}: keyboard activation shares only the public title and canonical URL; guest/member payloads match`, async (t) => {
    const payloads = [];
    for (const viewer of ["guest", "member"]) {
      const f = await open(t, view, { viewer });
      assert.deepEqual((await trace(f.page)).calls, [], "no native call on load");
      const button = await readyButton(f.page);
      await calendarAndCopy(f.page);
      const cookies = await f.context.cookies();
      const before = await liveText(f.page);
      await tabTo(f.page, button);
      await f.page.keyboard.press("Enter");
      await expect.poll(async () => (await trace(f.page)).calls.length).toBe(1);
      const state = await trace(f.page);
      payloads.push(state.calls[0].payload);
      assert.deepEqual(state.calls[0].payload, expectedPayload);
      assert.equal(state.calls[0].active, true, "native call must run within the user activation");
      assert.deepEqual(state.copied, [], "Share must remain separate from Copy link");
      assert.ok(!JSON.stringify(state.calls[0].payload).includes(PRIVATE_ID));
      assert.ok(!JSON.stringify(state.calls[0].payload).includes(PRIVATE_NAME));
      await expect(button).toBeFocused();
      await expect(button).toBeEnabled();
      assert.deepEqual(await f.context.cookies(), cookies);
      assert.equal(f.page.url(), SHARE_ORIGIN + SHARE_PATH + SHARE_QUERY);
      // An optional success announcement is allowed only after resolution;
      // this test does not impose UI wording or require a success toast.
      assert.ok(before.every((text) => !/shared successfully/i.test(text)));
      await noEscapedEffects(f);
    }
    assert.deepEqual(payloads, [expectedPayload, expectedPayload]);
  });

  for (const mode of ["cancel", "failure", "sync-failure"]) {
    test(`${view}: ${mode} restores the same keyboard action without false success or broken Copy link`, async (t) => {
      const f = await open(t, view, { mode });
      const button = await readyButton(f.page);
      const before = await liveText(f.page);
      await tabTo(f.page, button);
      await f.page.keyboard.press("Space");
      await expect.poll(async () => (await trace(f.page)).calls.length).toBe(1);
      await expect(button).toBeEnabled();
      assert.notEqual(await button.getAttribute("aria-disabled"), "true");
      await expect(button).toBeFocused();
      const after = await liveText(f.page);
      if (mode === "cancel") assert.deepEqual(after, before, "AbortError cancellation is silent");
      else
        assert.doesNotMatch(
          after.join(" "),
          /\b(?:event shared|shared successfully|share succeeded|success(?:ful(?:ly)?)|event link copied)\b|^\s*shared[.!]?\s*$/i,
          "failure must never claim success",
        );
      assert.deepEqual((await trace(f.page)).copied, []);
      // A second explicit gesture works: recovery must not leave a stuck pending flag.
      await f.page.keyboard.press("Enter");
      await expect.poll(async () => (await trace(f.page)).calls.length).toBe(2);
      await expect(button).toBeFocused();
      await calendarAndCopy(f.page);
      await f.page.getByTestId("event-copy-link").click();
      await expect(f.page.getByTestId("event-copy-toast")).toHaveText("Event link copied.");
      assert.deepEqual((await trace(f.page)).copied, [SHARE_CANONICAL]);
      await noEscapedEffects(f);
    });
  }

  for (const settlement of ["resolve", "cancel", "failure"]) {
    test(`${view}: pending duplicate activations are ignored, then ${settlement} permits a fresh share`, async (t) => {
      const f = await open(t, view, { mode: "pending" });
      const button = await readyButton(f.page);
      const before = await liveText(f.page);
      await tabTo(f.page, button);
      await f.page.keyboard.press("Enter");
      await expect.poll(async () => (await trace(f.page)).calls.length).toBe(1);
      await f.page.keyboard.press("Enter");
      // Even a queued duplicate event must respect the pending guard.
      await button.evaluate((node) =>
        node.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      assert.equal((await trace(f.page)).calls.length, 1);
      assert.doesNotMatch(
        (await liveText(f.page)).join(" "),
        /\b(?:event shared|shared successfully|share succeeded|success(?:ful(?:ly)?)|event link copied)\b|^\s*shared[.!]?\s*$/i,
        "no success claim before the native promise settles; neutral pending guidance is allowed",
      );
      await calendarAndCopy(f.page);
      await f.page.evaluate((outcome) => {
        const pending = window.shareTrace.settlements.shift();
        if (outcome === "resolve") pending.resolve();
        else
          pending.reject(
            new DOMException(
              "Fixture settlement",
              outcome === "cancel" ? "AbortError" : "NotAllowedError",
            ),
          );
      }, settlement);
      await expect(button).toBeEnabled();
      await expect(button).toBeFocused();
      assert.notEqual(await button.getAttribute("aria-disabled"), "true");
      if (settlement === "cancel") assert.deepEqual(await liveText(f.page), before);
      if (settlement === "failure")
        assert.doesNotMatch(
          (await liveText(f.page)).join(" "),
          /\b(?:event shared|shared successfully|share succeeded|success(?:ful(?:ly)?)|event link copied)\b|^\s*shared[.!]?\s*$/i,
        );
      await f.page.keyboard.press("Enter");
      await expect.poll(async () => (await trace(f.page)).calls.length).toBe(2);
      await f.page.evaluate(() => window.shareTrace.settlements.shift().resolve());
      await noEscapedEffects(f);
    });
  }

  for (const capability of ["unsupported", "insecure"]) {
    test(`${view}: CONTROL ${capability} hides native Share and preserves the actual keyboard Copy link journey`, async (t) => {
      const f = await open(t, view, {
        mode: capability === "unsupported" ? "unsupported" : "success",
        insecure: capability === "insecure",
      });
      assert.equal(await nativeButton(f.page).count(), 0);
      assert.deepEqual((await trace(f.page)).calls, []);
      await calendarAndCopy(f.page);
      const copy = f.page.getByTestId("event-copy-link");
      await tabTo(f.page, copy);
      await f.page.keyboard.press("Enter");
      await expect(f.page.getByTestId("event-copy-toast")).toHaveText("Event link copied.");
      assert.deepEqual((await trace(f.page)).copied, [SHARE_CANONICAL]);
      await expect(copy).toBeFocused();
      await noEscapedEffects(f);
    });
  }

  test(`${view}: CONTROL clipboard refusal remains truthful and usable without native Share`, async (t) => {
    const f = await open(t, view, { mode: "unsupported", clipboard: "denied" });
    await f.page.getByTestId("event-copy-link").click();
    await expect(f.page.getByTestId("event-copy-toast")).toHaveText(
      "That link didn't copy — copy it from the address bar.",
    );
    assert.deepEqual((await trace(f.page)).calls, []);
    await expect(f.page.getByTestId("event-copy-link")).toBeFocused();
    await calendarAndCopy(f.page);
    await noEscapedEffects(f);
  });

  test(`${view}: CONTROL real no-JS client keeps calendar and canonical Copy link navigation, no focusable Share`, async (t) => {
    const f = await open(t, view, { javaScriptEnabled: false });
    assert.equal(await nativeButton(f.page).count(), 0);
    await calendarAndCopy(f.page);
    const copy = f.page.getByTestId("event-copy-link");
    await tabTo(f.page, copy);
    await f.page.keyboard.press("Enter");
    await expect(f.page).toHaveURL(SHARE_CANONICAL);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.dialogs, []);
    assert.deepEqual(f.blocked, []);
  });

  for (const scenario of [
    { name: "moderator draft", viewer: "moderator", status: "draft" },
    { name: "gone", status: "cancelled" },
    { name: "missing", missing: true },
  ]) {
    test(`${view}: CONTROL ${scenario.name} never offers or automatically starts native sharing`, async (t) => {
      const f = await open(t, view, scenario);
      assert.equal(
        await f.page.getByRole("button", { name: SHARE_NAME, includeHidden: true }).count(),
        0,
      );
      assert.deepEqual((await trace(f.page)).calls, []);
      await noEscapedEffects(f);
    });
  }

  test(`${view}: hostile public title is shared literally, never executed or enriched with private context`, async (t) => {
    const title = 'Chess "night" </button><img src=x onerror="window.__titleExecuted=true"> ♟';
    const f = await open(t, view, { title, viewer: "member" });
    assert.equal(await f.page.evaluate(() => window.__titleExecuted), undefined);
    const button = await readyButton(f.page);
    await button.click();
    await expect.poll(async () => (await trace(f.page)).calls.length).toBe(1);
    assert.deepEqual((await trace(f.page)).calls[0].payload, { title, url: SHARE_CANONICAL });
    await noEscapedEffects(f);
  });

  if (evidence)
    test(`${view}: capture current fixture at both required widths`, async (t) => {
      const f = await open(t, view);
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ]) {
        await f.page.setViewportSize({ width, height });
        await f.page.screenshot({
          path: resolve(evidence, `${view.toLowerCase()}-${width}x${height}.png`),
          fullPage: true,
        });
      }
      assert.equal(await f.page.getByTestId("event-copy-link").count(), 1);
    });
}
