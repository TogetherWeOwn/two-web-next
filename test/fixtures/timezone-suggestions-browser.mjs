// Browser plumbing only: real renderers/controllers, intercepted memory reads/writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { PROFILE_OPENED_AT_FIELD } from "../../src/islands/contracts.ts";
import {
  timezoneEventFixture,
  timezoneProfileFixture,
  ZONE_INPUT,
  ZONE_ORIGIN,
  ZONE_ROOT,
} from "./timezone-suggestions.ts";

export const PROVIDED_ZONES = ["Europe/Paris", "America/New_York", "Asia/Tokyo"];
export async function settle(page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
export async function openZoneControl(browser, view, control, options = {}) {
  const profile = control === "profile" ? await timezoneProfileFixture(view) : null;
  const event = control === "event" ? await timezoneEventFixture(view) : null;
  const path = profile?.path ?? event.path;
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Asia/Tokyo",
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    viewport: options.viewport ?? { width: 1280, height: 800 },
    serviceWorkers: "block",
  });
  const requests = [];
  const writes = [];
  const errors = [];
  const responses = [];
  let withholdProfileIsland = options.withholdProfileIslandUntilWrite ?? false;
  let release;
  let deferred;
  let received;
  const receivedWrite = new Promise((r) => {
    received = r;
  });
  if (options.deferWrite)
    deferred = new Promise((r) => {
      release = r;
    });
  await context.addInitScript(
    ({ mode, values }) => {
      window.__zoneCalls = [];
      window.__zoneEffects = { fetch: 0, xhr: 0, beacon: 0, geo: 0, storage: 0 };
      if (mode === "missing-intl") Object.defineProperty(window, "Intl", { value: undefined });
      else if (mode === "missing")
        Object.defineProperty(Intl, "supportedValuesOf", { configurable: true, value: undefined });
      else if (mode === "getter-throws")
        Object.defineProperty(Intl, "supportedValuesOf", {
          configurable: true,
          get() {
            throw new Error("Unavailable capability getter");
          },
        });
      else
        Object.defineProperty(Intl, "supportedValuesOf", {
          configurable: true,
          value(key) {
            window.__zoneCalls.push(key);
            if (mode === "throws") throw new RangeError("Unsupported Intl key");
            return values;
          },
        });
      if (mode === "no-datalist")
        Object.defineProperty(HTMLInputElement.prototype, "list", { get: () => null });
      const fetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        window.__zoneEffects.fetch++;
        return fetch(...args);
      };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (...args) {
        window.__zoneEffects.xhr++;
        return open.apply(this, args);
      };
      navigator.sendBeacon = () => {
        window.__zoneEffects.beacon++;
        return true;
      };
      for (const key of ["getCurrentPosition", "watchPosition"])
        Object.defineProperty(navigator.geolocation, key, {
          configurable: true,
          value: () => {
            window.__zoneEffects.geo++;
          },
        });
      for (const key of ["setItem", "removeItem", "clear"])
        Storage.prototype[key] = () => {
          window.__zoneEffects.storage++;
        };
    },
    { mode: options.mode ?? "supported", values: options.values ?? PROVIDED_ZONES },
  );
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), url: url.href });
    if (url.origin !== ZONE_ORIGIN) return route.abort();
    if (url.pathname === "/islands/member-profile.js" && withholdProfileIsland)
      return route.fulfill({
        contentType: "text/javascript",
        body: "/* awaiting native refusal */",
      });
    if (profile && (url.pathname === "/profile" || url.pathname.startsWith("/members/"))) {
      const headers = await request.allHeaders();
      const init = {
        method: request.method(),
        headers,
        body: request.postData() ?? undefined,
      };
      if (request.method() !== "GET") {
        withholdProfileIsland = false;
        writes.push({ method: request.method(), body: request.postData() });
        received();
        if (deferred) await deferred;
      }
      let response = await profile.request(view, url.pathname, init);
      responses.push({ method: request.method(), status: response.status });
      if ([302, 303].includes(response.status)) {
        const location = new URL(response.headers.get("location"), ZONE_ORIGIN);
        assert.equal(location.origin, ZONE_ORIGIN);
        response = await profile.request(view, location.pathname);
      }
      let body = await response.text();
      if (response.headers.get("content-type")?.includes("text/html"))
        body = body.replace(
          new RegExp(`(name="${PROFILE_OPENED_AT_FIELD}" value=")[^"]+`),
          (_, prefix) => prefix + String(Date.now() - 5000),
        );
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body,
      });
    }
    if (event && url.pathname === event.path)
      return route.fulfill({ contentType: "text/html", body: event.html });
    const file = resolve(ZONE_ROOT, "public", `.${url.pathname}`);
    if (file.startsWith(resolve(ZONE_ROOT, "public") + sep)) {
      try {
        return route.fulfill({
          body: readFileSync(file),
          contentType: file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "application/octet-stream",
        });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
      }
    }
    return route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(ZONE_ORIGIN + path);
    if (event?.client && options.javaScriptEnabled !== false)
      await page.addScriptTag({ content: event.client });
    const input = page.locator(ZONE_INPUT[control]).first();
    if (profile && !(await input.isVisible())) await page.getByTestId("profile-edit").click();
    if (options.javaScriptEnabled !== false) await settle(page);
    if (await input.isVisible()) await input.focus();
    return {
      context,
      page,
      input,
      profile,
      requests,
      writes,
      responses,
      errors,
      receivedWrite,
      releaseWrite: () => release?.(),
      async rebind() {
        if (view === "Kit" && control === "event")
          await page.evaluate(() => window.__zoneRerender());
        // Native islands enhance SSR-only Kit routes too. Replaced DOM needs
        // their real initializer; load served bytes without bypassing CSP.
        await page.addScriptTag({
          url: new URL(
            `/islands/${control === "profile" ? "member-profile.js" : "event-device-timezone.js"}`,
            ZONE_ORIGIN,
          ).href,
        });
        await settle(page);
        if (await input.isVisible()) await input.focus();
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function listState(input) {
  return input.evaluate((node) => ({
    type: node.type,
    listId: node.getAttribute("list"),
    native: node.list?.tagName ?? null,
    ids: node.list
      ? [...document.querySelectorAll("[id]")].filter((n) => n.id === node.list.id).length
      : 0,
    values: node.list ? [...node.list.options].map((option) => option.value) : [],
    named: node.labels?.length ?? 0,
  }));
}
export async function dirty(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
export async function compareResult(page) {
  return page.getByTestId("event-chosen-timezone-status").textContent();
}
export async function noSuggestionEffects(fixture, expectedWrites = 0) {
  assert.deepEqual(await fixture.page.evaluate(() => window.__zoneEffects), {
    fetch: 0,
    xhr: 0,
    beacon: 0,
    geo: 0,
    storage: 0,
  });
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.writes.length, expectedWrites);
  assert.ok(fixture.requests.every((request) => new URL(request.url).origin === ZONE_ORIGIN));
}
