// Independent, test-author-owned contract. No application implementation here.
// LCT-1 activation/labels; LCT-2 one instant/no ticking; LCT-3 truthful civil time;
// LCT-4 safe fallback; LCT-5 no extra authority/effects; LCT-6 editor isolation.
// Run (no DB): A11Y_BROWSER_TESTS=true npx vitest run test/profile-local-time-comparison-acceptance.test.ts
// Root + web locked dev dependencies and Playwright Chromium are required.
// The combined implementation PR must add this file to the existing a11y browser
// step and its a11y-require-executed verifier: ancestor below, minimum 72 cases.
// The inventory gate already discovers this .test.ts. Do not merge RED alone.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIXED_NOW,
  ORIGIN,
  OWNER,
  participationFixture,
  type Presentation,
  type Renderer,
} from "./helpers/profile-participation";

const VIEWS = ["Hono", "Kit"] as const;
const ARTIFACTS = ["source", "shipped"] as const;
type Artifact = (typeof ARTIFACTS)[number];
type Failure = "none" | "missing Intl" | "missing formatter" | "throwing formatter";
const START = "2026-07-15T19:00:00.000Z";

// Literal, independently calculated dates/times. Permit normal long/short/numeric
// en-GB presentations, 12/24-hour clocks, and punctuation; do not call app helpers
// to generate the oracle. Each person's date AND time must belong to their label.
function civilDate(day: string, month: string, numericMonth: string, year = "2026") {
  const short = month.slice(0, 3);
  return new RegExp(
    `(?:\\b0?${day} ${short}(?:${month.slice(3)})? ${year}\\b|\\b${short}(?:${month.slice(3)})? 0?${day},? ${year}\\b|\\b${year}-${numericMonth}-${day.padStart(2, "0")}\\b|\\b0?${day}[/.]${numericMonth}[/.]${year}\\b)`,
    "i",
  );
}
const CLOCKS = [
  {
    id: "T1 summer",
    instant: START,
    member: "Europe/London",
    device: "America/New_York",
    memberDate: civilDate("15", "July", "07"),
    memberTime: /\b20:00\b|\b8:00\s*pm\b/i,
    deviceDate: civilDate("15", "July", "07"),
    deviceTime: /\b15:00\b|\b3:00\s*pm\b/i,
  },
  {
    id: "T2 different years",
    instant: "2026-12-31T12:30:00.000Z",
    member: "Pacific/Kiritimati",
    device: "Pacific/Honolulu",
    memberDate: civilDate("1", "January", "01", "2027"),
    memberTime: /\b0?2:30\b(?:\s*am)?/i,
    deviceDate: civilDate("31", "December", "12"),
    deviceTime: /\b0?2:30\b(?:\s*am)?/i,
  },
  {
    id: "T3 before spring gap",
    instant: "2026-03-08T06:59:00.000Z",
    member: "America/New_York",
    device: "UTC",
    memberDate: civilDate("8", "March", "03"),
    memberTime: /\b0?1:59\b(?:\s*am)?/i,
    deviceDate: civilDate("8", "March", "03"),
    deviceTime: /\b0?6:59\b(?:\s*am)?/i,
  },
  {
    id: "T4 after spring gap",
    instant: "2026-03-08T07:01:00.000Z",
    member: "America/New_York",
    device: "UTC",
    memberDate: civilDate("8", "March", "03"),
    memberTime: /\b0?3:01\b(?:\s*am)?/i,
    deviceDate: civilDate("8", "March", "03"),
    deviceTime: /\b0?7:01\b(?:\s*am)?/i,
  },
  {
    id: "T5 first autumn fold",
    instant: "2026-11-01T05:30:00.000Z",
    member: "America/New_York",
    device: "UTC",
    memberDate: civilDate("1", "November", "11"),
    memberTime: /\b0?1:30\b(?:\s*am)?/i,
    deviceDate: civilDate("1", "November", "11"),
    deviceTime: /\b0?5:30\b(?:\s*am)?/i,
  },
  {
    id: "T6 second autumn fold",
    instant: "2026-11-01T06:30:00.000Z",
    member: "America/New_York",
    device: "UTC",
    memberDate: civilDate("1", "November", "11"),
    memberTime: /\b0?1:30\b(?:\s*am)?/i,
    deviceDate: civilDate("1", "November", "11"),
    deviceTime: /\b0?6:30\b(?:\s*am)?/i,
  },
  {
    id: "T7 half-hour and date rollover",
    instant: "2026-01-15T14:00:00.000Z",
    member: "Australia/Adelaide",
    device: "UTC",
    memberDate: civilDate("16", "January", "01"),
    memberTime: /\b00:30\b|\b12:30\s*am\b/i,
    deviceDate: civilDate("15", "January", "01"),
    deviceTime: /\b14:00\b|\b2:00\s*pm\b/i,
  },
  {
    id: "T8 quarter-hour",
    instant: "2026-07-15T23:30:00.000Z",
    member: "Asia/Kathmandu",
    device: "Europe/London",
    memberDate: civilDate("16", "July", "07"),
    memberTime: /\b0?5:15\b(?:\s*am)?/i,
    deviceDate: civilDate("16", "July", "07"),
    deviceTime: /\b00:30\b|\b12:30\s*am\b/i,
  },
  {
    id: "T9 identical zones still label both people",
    instant: START,
    member: "UTC",
    device: "UTC",
    memberDate: civilDate("15", "July", "07"),
    memberTime: /\b19:00\b|\b7:00\s*pm\b/i,
    deviceDate: civilDate("15", "July", "07"),
    deviceTime: /\b19:00\b|\b7:00\s*pm\b/i,
  },
] as const;

// Controls exercise real admission/loader/rendering and counted keyed reads,
// not a substitute HTML fixture. Removing member admission or adding a new
// read/projection to support this local-only enhancement must fail here.
describe("profile local time comparison: route controls", () => {
  for (const renderer of VIEWS) {
    it(`${renderer} CONTROL member projection retains one keyed read and existing timezone`, async () => {
      const fixture = await participationFixture("other member");
      fixture.store.rows.get(OWNER)!.timezone = "Asia/Kathmandu";
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toMatch(/no-store/);
      const html = await response.text();
      expect(html).toContain("Timezone: Asia/Kathmandu");
      expect(html).not.toContain("Private viewer marker");
      expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
      expect(fixture.audit).toHaveLength(1);
    });
    it(`${renderer} CONTROL guest cannot acquire member timezone`, async () => {
      const fixture = await participationFixture("other member", { guest: true });
      fixture.store.rows.get(OWNER)!.timezone = "Asia/Kathmandu";
      const response = await fixture.request(renderer);
      expect(response.status).toBe(302);
      expect(await response.text()).not.toContain("Asia/Kathmandu");
      expect(fixture.operations).toEqual([]);
    });
    it(`${renderer} CONTROL audit refusal does not expose the comparison or profile`, async () => {
      const fixture = await participationFixture("other member", { auditOk: false });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).not.toContain("Compare local times");
      expect(html).not.toContain("Fixture member");
      expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
    });
  }
});

describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "profile local time comparison in Chromium",
  () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED_NOW);
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterEach(async () => {
      await Promise.all(contexts.splice(0).map((context) => context.close()));
    });
    afterAll(async () => {
      await browser?.close();
      vi.useRealTimers();
    });

    async function open(
      renderer: Renderer,
      options: {
        artifact?: Artifact;
        presentation?: Presentation;
        zone?: string | null;
        device?: string;
        instant?: string;
        failure?: Failure;
        javaScriptEnabled?: boolean;
      } = {},
    ) {
      const fixture = await participationFixture(options.presentation ?? "other member");
      fixture.store.rows.get(OWNER)!.timezone =
        options.zone === undefined ? "Europe/London" : options.zone;
      const context = await browser.newContext({
        javaScriptEnabled: options.javaScriptEnabled ?? true,
        locale: "en-GB",
        timezoneId: options.device ?? "America/New_York",
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
      });
      contexts.push(context);
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(options.instant ?? START));
      await context.addInitScript(`(() => {
        const failure = ${JSON.stringify(options.failure ?? "none")};
        if (failure === 'missing Intl') Object.defineProperty(globalThis, 'Intl', { value: undefined, configurable: true });
        else if (failure === 'missing formatter') Intl.DateTimeFormat = undefined;
        else if (failure === 'throwing formatter') Intl.DateTimeFormat = function() { throw new Error('Synthetic unavailable formatter'); };
        window.comparisonEffects = { fetch: 0, xhr: 0, beacon: 0, storage: 0, cookies: 0, geolocation: 0, timeout: 0, interval: 0 };
        for (const name of ['setTimeout', 'setInterval']) {
          const original = window[name].bind(window);
          window[name] = (...args) => { window.comparisonEffects[name === 'setTimeout' ? 'timeout' : 'interval']++; return original(...args); };
        }
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (...args) => { window.comparisonEffects.fetch++; return nativeFetch(...args); };
        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(...args) { window.comparisonEffects.xhr++; return nativeOpen.apply(this, args); };
        navigator.sendBeacon = () => { window.comparisonEffects.beacon++; return false; };
        for (const name of ['getCurrentPosition', 'watchPosition']) Object.defineProperty(navigator.geolocation, name, { configurable: true, value: () => { window.comparisonEffects.geolocation++; } });
        for (const name of ['setItem', 'removeItem', 'clear']) {
          const native = Storage.prototype[name];
          Storage.prototype[name] = function(...args) { window.comparisonEffects.storage++; return native.apply(this, args); };
        }
        const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', { get() { return cookie.get.call(this); }, set(value) { window.comparisonEffects.cookies++; cookie.set.call(this, value); } });
      })()`);
      const errors: string[] = [];
      const dynamicRequests: string[] = [];
      const requests: string[] = [];
      const writes: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push(`${request.method()} ${url.href}`);
        if (["fetch", "xhr", "ping", "websocket"].includes(request.resourceType()))
          dynamicRequests.push(`${request.method()} ${url.pathname}`);
        if (url.origin !== ORIGIN) return route.abort();
        if (
          url.pathname.startsWith("/islands/") &&
          /^\/islands\/[a-z0-9-]+\.js$/.test(url.pathname)
        ) {
          const root = options.artifact === "source" ? "assets" : "public";
          const file = resolve(root + url.pathname);
          expect(existsSync(file), `requested ${root} island must exist`).toBe(true);
          return route.fulfill({
            contentType: "text/javascript",
            body:
              options.artifact === "source"
                ? (
                    await build({
                      entryPoints: [file],
                      bundle: true,
                      platform: "browser",
                      format: "iife",
                      minify: false,
                      write: false,
                    })
                  ).outputFiles[0]!.text
                : readFileSync(file, "utf8"),
          });
        }
        if (url.pathname.endsWith(".css")) {
          const file = resolve("public" + url.pathname);
          return route.fulfill({
            contentType: "text/css",
            body: existsSync(file) ? readFileSync(file, "utf8") : "",
          });
        }
        if (url.pathname !== fixture.path && url.pathname !== `/members/${OWNER}`)
          return route.fulfill({ status: 204 });
        if (request.method() !== "GET") writes.push(request.method());
        const response = await fixture.request(renderer, url.pathname, {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() ?? undefined,
        });
        let body = await response.text();
        if (response.headers.get("content-type")?.includes("text/html"))
          body = body.replace(
            /(name="formOpenedAt" value=")[^"]+/,
            `$1${FIXED_NOW.getTime() - 5000}`,
          );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body,
        });
      });
      await page.goto(ORIGIN + fixture.path);
      if (options.javaScriptEnabled !== false) await settle(page);
      expect(errors, "rendered islands must not throw during mount").toEqual([]);
      return {
        ...fixture,
        page,
        errors,
        dynamicRequests,
        writes,
        requests,
        initialRequests: requests.slice(),
      };
    }
    const button = (page: Page) =>
      page.getByRole("button", { name: "Compare local times", exact: true });
    const result = (page: Page) => page.getByRole("status").filter({ hasText: /checked at/i });
    async function settle(page: Page) {
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    }
    async function activate(page: Page) {
      expect(
        await button(page).count(),
        "LCT-1: one explicit Compare local times action beside the rendered timezone",
      ).toBe(1);
      expect(await button(page).isVisible()).toBe(true);
      expect(await button(page).isEnabled()).toBe(true);
      await button(page).click();
      await settle(page);
      expect(
        await result(page).count(),
        "LCT-1: requested result has a polite status and checked-at wording",
      ).toBe(1);
      expect(await result(page).isVisible()).toBe(true);
      expect(
        [null, "polite"],
        "LCT-1: role=status is implicitly polite; do not override it off or assertive",
      ).toContain(await result(page).getAttribute("aria-live"));
      expect(
        await button(page).evaluate((element) => element === element.ownerDocument.activeElement),
        "LCT-1: focus stays on the activating control",
      ).toBe(true);
    }
    async function noEffects(fixture: Awaited<ReturnType<typeof open>>) {
      expect(await fixture.page.evaluate("window.comparisonEffects")).toEqual({
        fetch: 0,
        xhr: 0,
        beacon: 0,
        storage: 0,
        cookies: 0,
        geolocation: 0,
        timeout: 0,
        interval: 0,
      });
      expect(fixture.dynamicRequests).toEqual([]);
      expect(
        fixture.requests,
        "LCT-5: activation cannot initiate any additional network request",
      ).toEqual(fixture.initialRequests);
      expect(fixture.writes).toEqual([]);
      expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
      expect(fixture.errors).toEqual([]);
    }
    function labelled(text: string, person: "member" | "device") {
      // No fixed layout/IDs/punctuation: labels identify whose civil time it is.
      // Split at the next person's label so swapped rows cannot pass by finding
      // both correct numbers somewhere in the same status.
      const labels = [
        ...text.matchAll(/\b(?:fixture\s+)?member\b|\b(?:your\s+)?device\b|\bchecked at\b/gi),
      ];
      const index = labels.findIndex((match) => match[0].toLowerCase().includes(person));
      expect(index, `LCT-1: explicit ${person} label in requested result`).toBeGreaterThanOrEqual(
        0,
      );
      return text.slice(labels[index]!.index, labels[index + 1]?.index ?? text.length);
    }
    async function editorState(page: Page) {
      return {
        timezone: await page.locator('[name="timezone"]').inputValue(),
        bio: await page.locator('[name="bio"]').inputValue(),
        games: await page.locator('[name="games_text"]').inputValue(),
        optOut: await page.locator("#profile-leaderboard-opt-out").isChecked(),
        dirty: await page.evaluate(
          "(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })()",
        ),
      };
    }
    async function showEditor(page: Page) {
      if (!(await page.locator('[name="timezone"]').isVisible()))
        await page.getByTestId("profile-edit").click();
    }

    for (const renderer of VIEWS) {
      for (const artifact of ARTIFACTS) {
        for (const clock of CLOCKS) {
          it(`${renderer}/${artifact} LCT-3 ${clock.id}: both dated local times describe one checked instant`, async () => {
            const fixture = await open(renderer, {
              artifact,
              zone: clock.member,
              device: clock.device,
              instant: clock.instant,
            });
            expect(
              await result(fixture.page).count(),
              "LCT-2: no unsolicited comparison at mount",
            ).toBe(0);
            await activate(fixture.page);
            const text = (await result(fixture.page).innerText()).replace(/\s+/g, " ");
            const member = labelled(text, "member");
            const device = labelled(text, "device");
            expect(member).toContain(clock.member);
            expect(member).toMatch(clock.memberDate);
            expect(member).toMatch(clock.memberTime);
            expect(device).toContain(clock.device);
            expect(device).toMatch(clock.deviceDate);
            expect(device).toMatch(clock.deviceTime);
            const checked = text.slice(text.toLowerCase().indexOf("checked at"));
            const utcTime = clock.instant.slice(11, 16);
            expect(
              checked.includes(clock.instant) ||
                checked.includes(utcTime) ||
                clock.memberTime.test(checked) ||
                clock.deviceTime.test(checked),
              "LCT-2: checked-at includes the requested instant, not an undated static caption",
            ).toBe(true);
            expect(text).not.toMatch(
              /\b(?:is (?:available|online|offline)|last seen|available to play)\b/i,
            );
            await noEffects(fixture);
          });
        }
        it(`${renderer}/${artifact} LCT-2 activation refreshes a frozen result, never a live clock`, async () => {
          const fixture = await open(renderer, { artifact });
          const { page } = fixture;
          await activate(page);
          const initial = await result(page).innerText();
          await page.clock.setFixedTime(new Date("2026-07-16T20:45:00.000Z"));
          await settle(page);
          expect(await result(page).innerText()).toBe(initial);
          await activate(page);
          const refreshed = await result(page).innerText();
          expect(refreshed).not.toBe(initial);
          expect(labelled(refreshed, "member")).toMatch(civilDate("16", "July", "07"));
          expect(labelled(refreshed, "member")).toMatch(/\b21:45\b|\b9:45\s*pm\b/i);
          expect(labelled(refreshed, "device")).toMatch(/\b16:45\b|\b4:45\s*pm\b/i);
          await noEffects(fixture);
        });
        it(`${renderer}/${artifact} LCT-2 one clock snapshot even when subsequent reads cross midnight`, async () => {
          const fixture = await open(renderer, { artifact });
          const { page } = fixture;
          expect(await button(page).count(), "LCT-1: explicit activation exists").toBe(1);
          await page.evaluate(`(() => {
            const Native = Date;
            let instant = Native.parse('2026-07-15T23:59:00.000Z');
            const next = () => { const value = instant; instant += 120000; return value; };
            globalThis.Date = new Proxy(Native, {
              construct(target, args) { return Reflect.construct(target, args.length ? args : [next()]); },
              apply() { return new Native(next()).toString(); },
              get(target, key) { return key === 'now' ? next : Reflect.get(target, key); }
            });
          })()`);
          await activate(page);
          const text = await result(page).innerText();
          expect(labelled(text, "member")).toMatch(civilDate("16", "July", "07"));
          expect(labelled(text, "member")).toMatch(/\b00:59\b|\b12:59\s*am\b/i);
          expect(labelled(text, "device")).toMatch(civilDate("15", "July", "07"));
          expect(labelled(text, "device")).toMatch(/\b19:59\b|\b7:59\s*pm\b/i);
          await noEffects(fixture);
        });
      }
      for (const presentation of ["completed owner", "other member"] as const) {
        it(`${renderer} LCT-1 ${presentation}: keyboard activates without submitting or moving focus`, async () => {
          const fixture = await open(renderer, { presentation });
          const { page } = fixture;
          expect(await button(page).count()).toBe(1);
          // Must be adjacent in the existing timezone's metadata, not a new edit
          // form or separate member fetch. Native tab navigation must reach it.
          expect(
            await page
              .getByTestId("profile-timezone")
              .locator("..")
              .getByRole("button", { name: "Compare local times", exact: true })
              .count(),
          ).toBe(1);
          for (let n = 0; n < 30; n++) {
            await page.keyboard.press("Tab");
            if (
              await button(page).evaluate(
                (element) => element === element.ownerDocument.activeElement,
              )
            )
              break;
          }
          expect(
            await button(page).evaluate(
              (element) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          await page.keyboard.press("Enter");
          await settle(page);
          expect(await result(page).count()).toBe(1);
          expect(
            await button(page).evaluate(
              (element) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          const first = await result(page).innerText();
          await page.clock.setFixedTime(new Date("2026-07-15T20:00:00.000Z"));
          await page.keyboard.press("Space");
          await settle(page);
          expect(await result(page).innerText()).not.toBe(first);
          await noEffects(fixture);
        });
      }
      for (const zone of [null, "", "Mars/Olympus", "Europe/../London"]) {
        it(`${renderer} LCT-4 CONTROL ${JSON.stringify(zone)} retains text with no active broken enhancement`, async () => {
          const fixture = await open(renderer, { zone });
          expect(await fixture.page.getByTestId("profile-timezone").isVisible()).toBe(true);
          if (zone)
            expect(await fixture.page.getByTestId("profile-timezone").innerText()).toContain(zone);
          expect(await button(fixture.page).count()).toBe(0);
          expect(await result(fixture.page).count()).toBe(0);
          await noEffects(fixture);
        });
      }
      for (const failure of ["missing Intl", "missing formatter", "throwing formatter"] as const) {
        it(`${renderer} LCT-4 CONTROL ${failure}: existing text survives without an unusable action`, async () => {
          const fixture = await open(renderer, { failure });
          expect(await fixture.page.getByTestId("profile-timezone").innerText()).toContain(
            "Europe/London",
          );
          expect(await button(fixture.page).count()).toBe(0);
          expect(await result(fixture.page).count()).toBe(0);
          await noEffects(fixture);
        });
      }
      it(`${renderer} LCT-4 CONTROL no JS preserves member text and owner manual editor`, async () => {
        const fixture = await open(renderer, {
          javaScriptEnabled: false,
          presentation: "completed owner",
        });
        expect(await fixture.page.getByTestId("profile-timezone").innerText()).toContain(
          "Europe/London",
        );
        expect(await button(fixture.page).count()).toBe(0);
        expect(await fixture.page.getByRole("combobox", { name: /timezone/i }).isEditable()).toBe(
          true,
        );
        expect(await fixture.page.locator('[name="timezone"]').inputValue()).toBe("Europe/London");
        expect(fixture.writes).toEqual([]);
        expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
      });
      it(`${renderer} LCT-6 comparison uses saved timezone, never edits or clears a dirty owner draft`, async () => {
        const fixture = await open(renderer, { presentation: "completed owner" });
        const { page } = fixture;
        await showEditor(page);
        await page.locator('[name="timezone"]').fill("Asia/Tokyo");
        await page.locator('[name="bio"]').fill("Unsaved game-night draft");
        const before = await editorState(page);
        expect(before.dirty).toBe(true);
        await activate(page);
        expect(labelled(await result(page).innerText(), "member")).toContain("Europe/London");
        expect(await editorState(page)).toEqual(before);
        await noEffects(fixture);
        await page.getByTestId("profile-cancel").click();
        expect(await page.locator('[name="timezone"]').inputValue()).toBe("Europe/London");
        expect((await editorState(page)).dirty).toBe(false);
      });
      it.each([
        { compare: false, label: "CONTROL" },
        { compare: true, label: "comparison" },
      ])(
        `${renderer} $label LCT-6 pending older save preserves a newer draft`,
        async ({ compare }) => {
          const fixture = await open(renderer, { presentation: "completed owner" });
          const { page } = fixture;
          // Absence fails before entering the held-request rendezvous. The false
          // control proves this exact save fixture even before the feature exists.
          if (compare) await activate(page);
          await showEditor(page);
          await page.locator('[name="timezone"]').fill("Asia/Tokyo");
          let release!: () => void;
          let arrived!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const seen = new Promise<void>((resolve) => {
            arrived = resolve;
          });
          await page.route("**/members/*", async (route) => {
            if (route.request().method() !== "PATCH") return route.fallback();
            arrived();
            await gate;
            return route.fallback();
          });
          try {
            await page.getByTestId("profile-save").click();
            await seen;
            await page.locator('[name="timezone"]').fill("Asia/Kathmandu");
            const before = await editorState(page);
            const beforeEffects = await page.evaluate("window.comparisonEffects");
            const beforeRequests = fixture.dynamicRequests.slice();
            const beforeOperations = fixture.operations.slice();
            if (compare) await activate(page);
            expect(await editorState(page)).toEqual(before);
            expect(await page.evaluate("window.comparisonEffects")).toEqual(beforeEffects);
            expect(fixture.dynamicRequests).toEqual(beforeRequests);
            expect(fixture.operations).toEqual(beforeOperations);
            const response = page.waitForResponse(
              (response) => response.request().method() === "PATCH",
            );
            release();
            expect((await response).status()).toBe(200);
            await settle(page);
            expect(await page.locator('[name="timezone"]').inputValue()).toBe("Asia/Kathmandu");
            expect((await editorState(page)).dirty).toBe(true);
            expect(fixture.writes).toEqual(["PATCH"]);
            expect(
              fixture.operations.filter((operation) => operation.method === "save"),
            ).toHaveLength(1);
            expect(fixture.store.rows.get(OWNER)?.timezone).toBe("Asia/Tokyo");
            await page.getByTestId("profile-cancel").click();
            expect(await page.locator('[name="timezone"]').inputValue()).toBe("Asia/Tokyo");
            expect((await editorState(page)).dirty).toBe(false);
          } finally {
            release();
          }
        },
      );
      it(`${renderer} LCT-6 CONTROL device autofill remains a draft-only explicit action`, async () => {
        const fixture = await open(renderer, { presentation: "completed owner" });
        const { page } = fixture;
        await showEditor(page);
        const before = await editorState(page);
        expect(before.timezone).toBe("Europe/London");
        expect(before.dirty).toBe(false);
        await page.getByRole("button", { name: /use this device.s timezone/i }).click();
        expect(await page.locator('[name="timezone"]').inputValue()).toBe("America/New_York");
        expect((await editorState(page)).dirty).toBe(true);
        expect(fixture.store.rows.get(OWNER)?.timezone).toBe("Europe/London");
        await noEffects(fixture);
        await page.getByTestId("profile-cancel").click();
        expect(await editorState(page)).toEqual(before);
      });
    }
  },
);
