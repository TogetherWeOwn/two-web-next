// Acceptance contract: a native (no-JS) profile save that fails validation
// re-renders the edit form with the rejected draft in the controls. When the
// shipped island then initializes on that 422 page, the rejected draft must
// still count as unsaved work against the persisted profile: leaving is
// protected before any further edit, and Cancel restores the persisted
// values — not the rejected draft. Ordinary GET forms stay clean, a
// successful correction becomes the new baseline, and the no-JS path keeps
// working without the island.
//
// Stored profile "A" and rejected draft "B" below are synthetic. Everything
// runs on the real Hono profiles routes or real Svelte ProfileView SSR, with
// source/shipped member-profile binders. Transport uses in-memory stores and
// an ephemeral loopback server or intercepted local documents. No database,
// staging identity or external service is used.
//
// The browser cases are opt-in where Chromium is installed:
// A11Y_BROWSER_TESTS=true npx vitest run test/member-profile-native-422-baseline.test.ts
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { compileProfileView } from "./helpers/profile-participation";
import { registerProfileParticipationBrowserCases } from "./helpers/profile-participation-browser";

const ID = "100000000000000001";
const env = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;

// A: what the server has stored. B: the draft the member submits natively;
// only its timezone is invalid, so one correction can save the rest of B.
const A = {
  bio: "Stored bio A",
  games: ["Stored Game A"],
  games_text: "Stored Game A",
  timezone: "Europe/London",
  leaderboardOptOut: false,
};
const B = {
  bio: "Rejected bio B",
  games_text: "Rejected Game B\nSecond Game B",
  timezone: "Mars/Olympus",
  leaderboard_opt_out: "1",
};
const CORRECTED_TIMEZONE = "Asia/Tokyo";

async function setup(saveFailure?: Error) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: ID,
    username: "alice",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const member = {
    id: ID,
    username: "alice",
    avatar: null,
    bio: A.bio,
    games: [...A.games],
    timezone: A.timezone,
    leaderboardOptOut: A.leaderboardOptOut,
  };
  const store = createMemoryProfileStore([member]);
  const save = vi.spyOn(store, "save");
  if (saveFailure) save.mockRejectedValue(saveFailure);
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  const get = () => app.request("/profile", { headers: { cookie } }, env);
  const nativePost = (fields: Record<string, string>) =>
    app.request(
      `/members/${ID}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _method: "PATCH",
          [PROFILE_HONEY_FIELD]: "",
          [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000),
          ...fields,
        }).toString(),
      },
      env,
    );
  return { app, cookie, store, save, get, nativePost };
}

describe("native profile 422 response (route level)", () => {
  it("keeps the rejected draft visible in the controls, the stored profile on display, and nothing written", async () => {
    const { nativePost, save, store } = await setup();
    const res = await nativePost({ ...B });
    expect(res.status).toBe(422);
    const html = await res.text();

    // B stays in the controls so the member can correct it.
    expect(html).toContain(`>${B.bio}</textarea>`);
    expect(html).toContain(`>${B.games_text}</textarea>`);
    expect(html).toContain(`value="${B.timezone}"`);
    expect(html).toMatch(/id="profile-leaderboard-opt-out"[^>]*checked/);
    // The read-only display still shows the stored profile A.
    expect(html).toContain(`data-testid="profile-bio"`);
    expect(html).toContain(A.bio);
    expect(html).toContain(`Timezone: ${A.timezone}`);
    // The rejection is announced and associated with the invalid control.
    expect(html).toContain('data-testid="profile-error"');
    expect(html).toContain('href="#profile-timezone"');
    expect(html).toContain('id="profile-timezone-error"');
    expect(html).toContain("Choose a valid IANA timezone");
    const timezoneInput = html.match(/<input\b[^>]*name="timezone"[^>]*>/)?.[0] ?? "";
    expect(timezoneInput).toContain('aria-invalid="true"');
    expect(timezoneInput).toContain(
      'aria-describedby="profile-timezone-help profile-timezone-error"',
    );
    // Nothing was persisted.
    expect(save).not.toHaveBeenCalled();
    expect(await store.find(ID)).toMatchObject({
      bio: A.bio,
      games: A.games,
      timezone: A.timezone,
      leaderboardOptOut: A.leaderboardOptOut,
    });
  });

  it("renders an ordinary GET form from the stored profile with no error chrome", async () => {
    const { get } = await setup();
    const res = await get();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`>${A.bio}</textarea>`);
    expect(html).toContain(`>${A.games_text}</textarea>`);
    expect(html).toContain(`value="${A.timezone}"`);
    expect(html).not.toMatch(/id="profile-leaderboard-opt-out"[^>]*checked/);
    expect(html).not.toContain('data-testid="profile-error"');
  });

  it("accepts a corrected native resubmission and stores it", async () => {
    const { nativePost, save, store } = await setup();
    const rejected = await nativePost({ ...B });
    expect(rejected.status).toBe(422);
    const corrected = await nativePost({ ...B, timezone: CORRECTED_TIMEZONE });
    expect(corrected.status).not.toBe(422);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await store.find(ID)).toMatchObject({
      bio: B.bio,
      games: ["Rejected Game B", "Second Game B"],
      timezone: CORRECTED_TIMEZONE,
      leaderboardOptOut: true,
    });
  });
});

// Real Chromium over the real SSR page and shipped binder. The first page
// load withholds the island script (a failed script load is one real way a
// member reaches the native POST) so the invalid submit navigates natively
// to the server-rendered 422 page; from then on the island serves normally
// and initializes on that 422 HTML.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "native 422 baseline in a real browser",
  () => {
    registerProfileParticipationBrowserCases();
    let browser: Browser;
    let renderKit: Awaited<ReturnType<typeof compileProfileView>>;
    const contexts: BrowserContext[] = [];
    const servers: Server[] = [];
    beforeAll(async () => {
      renderKit = await compileProfileView();
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterEach(async () => {
      await Promise.all(contexts.splice(0).map((context) => context.close()));
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    });

    async function openProfile(
      javaScriptEnabled: boolean,
      withholdIslandUntilWrite = true,
      saveFailure?: Error,
    ) {
      const fixture = await setup(saveFailure);
      const requests: { method: string; path: string; status: number; cacheControl: string }[] = [];
      const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
      contexts.push(context);
      const writes: { method: string; status: number }[] = [];
      // Withheld only until the first native write navigates; the 422 page
      // and everything after get the shipped binder.
      let withholdIsland = withholdIslandUntilWrite;
      const assets: Record<string, { body: string; contentType: string }> = {
        "/styles.css": { body: readFileSync("public/styles.css", "utf8"), contentType: "text/css" },
        "/islands/member-profile.js": {
          body: readFileSync("public/islands/member-profile.js", "utf8"),
          contentType: "text/javascript",
        },
        "/islands/avatar.js": {
          body: readFileSync("public/islands/avatar.js", "utf8"),
          contentType: "text/javascript",
        },
      };
      let base: string;
      const server = createServer(async (request, reply) => {
        try {
          const url = new URL(request.url!, base);
          const asset = assets[url.pathname];
          if (asset) {
            if (url.pathname === "/islands/member-profile.js" && withholdIsland) {
              reply.writeHead(404);
              reply.end();
              return;
            }
            reply.writeHead(200, { "content-type": asset.contentType });
            reply.end(asset.body);
            return;
          }
          if (url.pathname !== "/profile" && !url.pathname.startsWith("/members/")) {
            reply.writeHead(204);
            reply.end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const input = Buffer.concat(chunks).toString("utf8");
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(",") : value);
          }
          const response = await fixture.app.request(
            url.href,
            { method: request.method, headers, body: input || undefined },
            { ...env, APP_URL: base },
          );
          requests.push({
            method: request.method!,
            path: url.pathname,
            status: response.status,
            cacheControl: response.headers.get("cache-control") ?? "",
          });
          let body = await response.text();
          // Model time already spent editing, without sleeping or changing the trap.
          if (response.headers.get("content-type")?.includes("text/html")) {
            body = body.replace(
              new RegExp(`(name="${PROFILE_OPENED_AT_FIELD}" value=")[^"]+`),
              (_, prefix) => prefix + String(Date.now() - 5000),
            );
          }
          if (request.method !== "GET") {
            writes.push({ method: request.method!, status: response.status });
            withholdIsland = false;
          }
          reply.writeHead(response.status, Object.fromEntries(response.headers));
          reply.end(body);
        } catch (error) {
          reply.writeHead(500);
          reply.end(String(error));
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const separator = fixture.cookie.indexOf("=");
      await context.addCookies([
        {
          name: fixture.cookie.slice(0, separator),
          value: fixture.cookie.slice(separator + 1),
          url: base.replace("http:", "https:") + "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`${base}/profile`);
      return { ...fixture, page, writes, requests, base };
    }

    async function field(page: Page, name: string) {
      return page.locator(`[name="${name}"]`).first();
    }

    async function setField(page: Page, name: string, value: string) {
      const control = await field(page, name);
      await control.fill(value);
      expect(await control.inputValue()).toBe(value);
    }

    async function formState(page: Page) {
      const box = page.locator("#profile-leaderboard-opt-out");
      const checked = await box.evaluate((el) => (el as unknown as { checked: boolean }).checked);
      const departurePrevented = await page.evaluate<boolean>(
        "(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()",
      );
      return {
        bio: await (await field(page, "bio")).inputValue(),
        games_text: await (await field(page, "games_text")).inputValue(),
        timezone: await (await field(page, "timezone")).inputValue(),
        checked,
        departurePrevented,
      };
    }

    // Submit B natively; a valid timezone instead exercises an unavailable save.
    async function reachNativeRefusal(page: Page, timezone = B.timezone) {
      await setField(page, "bio", B.bio);
      await setField(page, "games_text", B.games_text);
      await setField(page, "timezone", timezone);
      await page.locator("#profile-leaderboard-opt-out").check();
      await Promise.all([page.waitForNavigation(), page.getByTestId("profile-save").click()]);
      await page.getByTestId("profile-error").waitFor();
    }

    it("treats the rejected draft as unsaved work on the 422 page and Cancel restores the stored profile", async () => {
      const { page, writes, save } = await openProfile(true);
      await reachNativeRefusal(page);
      expect(writes).toEqual([{ method: "POST", status: 422 }]);
      expect(save).not.toHaveBeenCalled();

      // B stays visible, and the server-rendered error association survives
      // island initialization.
      const initial = await formState(page);
      expect(initial.bio).toBe(B.bio);
      expect(initial.games_text).toBe(B.games_text);
      expect(initial.timezone).toBe(B.timezone);
      expect(initial.checked).toBe(true);
      const timezone = await field(page, "timezone");
      expect(await timezone.getAttribute("aria-invalid")).toBe("true");
      expect(await timezone.getAttribute("aria-describedby")).toContain("profile-timezone-error");
      expect(await page.locator("#profile-timezone-error").textContent()).toContain(
        "Choose a valid IANA timezone",
      );

      // Before any further edit, leaving would lose B, so it is protected.
      expect(initial.departurePrevented).toBe(true);

      // Cancel explicitly discards B and restores the persisted profile A
      // for every field, including the leaderboard switch.
      await page.getByTestId("profile-cancel").click();
      const cancelled = await formState(page);
      expect(cancelled.bio).toBe(A.bio);
      expect(cancelled.games_text).toBe(A.games_text);
      expect(cancelled.timezone).toBe(A.timezone);
      expect(cancelled.checked).toBe(A.leaderboardOptOut);
      expect(cancelled.departurePrevented).toBe(false);
      expect(writes).toHaveLength(1);
      expect(save).not.toHaveBeenCalled();
    });

    it("makes a successful correction the baseline that later Cancel restores", async () => {
      const { page, writes, save, store } = await openProfile(true);
      await reachNativeRefusal(page);

      await setField(page, "timezone", CORRECTED_TIMEZONE);
      await page.getByTestId("profile-save").click();
      await page.getByTestId("profile-saved").waitFor();
      expect(writes).toEqual([
        { method: "POST", status: 422 },
        { method: "PATCH", status: 200 },
      ]);
      expect(save).toHaveBeenCalledTimes(1);
      expect(await store.find(ID)).toMatchObject({
        bio: B.bio,
        timezone: CORRECTED_TIMEZONE,
        leaderboardOptOut: true,
      });

      await page.getByTestId("profile-edit-again").click();
      expect((await formState(page)).departurePrevented).toBe(false);
      await setField(page, "bio", "Throwaway edit");
      await page.locator("#profile-leaderboard-opt-out").uncheck();
      expect((await formState(page)).departurePrevented).toBe(true);
      await page.getByTestId("profile-cancel").click();
      const cancelled = await formState(page);
      expect(cancelled.bio).toBe(B.bio);
      expect(cancelled.games_text).toBe(B.games_text);
      expect(cancelled.timezone).toBe(CORRECTED_TIMEZONE);
      expect(cancelled.checked).toBe(true);
      expect(cancelled.departurePrevented).toBe(false);
    });

    it("keeps an ordinary GET form clean until edited, and Cancel restores the stored profile", async () => {
      const { page } = await openProfile(true, false);
      const initial = await formState(page);
      expect(initial).toMatchObject({
        bio: A.bio,
        games_text: A.games_text,
        timezone: A.timezone,
        checked: A.leaderboardOptOut,
        departurePrevented: false,
      });
      await setField(page, "bio", "Unsaved edit");
      expect((await formState(page)).departurePrevented).toBe(true);
      await page.getByTestId("profile-cancel").click();
      const cancelled = await formState(page);
      expect(cancelled.bio).toBe(A.bio);
      expect(cancelled.departurePrevented).toBe(false);
    });

    it("keeps the no-JS fallback intact: native 422 shows the draft and a corrected native save lands", async () => {
      const { page, writes, store } = await openProfile(false);
      await reachNativeRefusal(page);
      expect(writes).toEqual([{ method: "POST", status: 422 }]);
      expect(await (await field(page, "bio")).inputValue()).toBe(B.bio);
      expect(await (await field(page, "timezone")).getAttribute("aria-invalid")).toBe("true");

      await setField(page, "timezone", CORRECTED_TIMEZONE);
      await Promise.all([page.waitForNavigation(), page.getByTestId("profile-save").click()]);
      expect(await store.find(ID)).toMatchObject({
        bio: B.bio,
        games: ["Rejected Game B", "Second Game B"],
        timezone: CORRECTED_TIMEZONE,
        leaderboardOptOut: true,
      });
      expect(await page.getByTestId("profile-bio").textContent()).toContain(B.bio);
    });

    async function expectSavedEditor(page: Page, leaderboardOptOut = A.leaderboardOptOut) {
      await expect
        .poll(() => formState(page))
        .toEqual({
          bio: A.bio,
          games_text: A.games_text,
          timezone: A.timezone,
          checked: leaderboardOptOut,
          departurePrevented: false,
        });
      await expect
        .poll(() => page.locator("#profile-bio-count").textContent())
        .toBe("12 of 1000 characters");
      await expect
        .poll(() => page.locator("#profile-games-text-count").textContent())
        .toBe("1 of 20 games, 13 of 1700 characters");
      expect(await page.getByTestId("profile-error").count()).toBe(0);
      for (const id of ["bio", "games-text", "timezone", "leaderboard-opt-out"]) {
        expect(await page.locator(`#profile-${id}`).getAttribute("aria-invalid")).toBeNull();
        expect(await page.locator(`#profile-${id}-error`).count()).toBe(0);
      }
      expect(await page.locator("#profile-bio").getAttribute("aria-describedby")).toBe(
        "profile-bio-hint profile-bio-count",
      );
      expect(await page.locator("#profile-games-text").getAttribute("aria-describedby")).toBe(
        "profile-games-text-hint profile-games-text-count",
      );
      expect(await page.locator("#profile-timezone").getAttribute("aria-describedby")).toBe(
        "profile-timezone-help",
      );
    }

    function expectPrivateEditor(cacheControl: string) {
      const directives = cacheControl.split(",").map((directive) => directive.trim().toLowerCase());
      expect(directives).toContain("private");
      expect(directives).toContain("no-store");
    }

    // These catch native reset restoring the refused HTML defaults B instead
    // of saved A, and an enhancement accidentally following the fallback GET.
    // Run in the existing CI-executed browser group; no new opt-in or skip.
    for (const status of [422, 503]) {
      for (const javaScriptEnabled of [false, true]) {
        it(`Cancel after native ${status} restores all saved controls, counts and errors with JavaScript ${javaScriptEnabled ? "enabled in place" : "disabled via GET"}`, async () => {
          const log = vi.spyOn(console, "error").mockImplementation(() => {});
          try {
            const failure =
              status === 503
                ? Object.assign(new Error("fixture connection refused"), { code: "ECONNREFUSED" })
                : undefined;
            const { page, writes, requests, save, store } = await openProfile(
              javaScriptEnabled,
              true,
              failure,
            );
            const timezone = status === 422 ? B.timezone : CORRECTED_TIMEZONE;
            await reachNativeRefusal(page, timezone);
            expect(writes).toEqual([{ method: "POST", status }]);
            const attemptedSaves = status === 503 ? 1 : 0;
            expect(save).toHaveBeenCalledTimes(attemptedSaves);
            expectPrivateEditor(requests[0]!.cacheControl);
            expectPrivateEditor(requests[1]!.cacheControl);
            expect(await formState(page)).toEqual({
              bio: B.bio,
              games_text: B.games_text,
              timezone,
              checked: true,
              departurePrevented: javaScriptEnabled,
            });
            expect(await page.locator("#profile-bio-count").textContent()).toBe(
              "14 of 1000 characters",
            );
            // Native form encoding submits CRLF: 15 + 2 + 13 raw characters.
            expect(await page.locator("#profile-games-text-count").textContent()).toBe(
              "2 of 20 games, 30 of 1700 characters",
            );
            const baseline = page.locator("[data-saved-bio]");
            expect(await baseline.getAttribute("data-saved-bio")).toBe(A.bio);
            expect(await baseline.getAttribute("data-saved-games-text")).toBe(A.games_text);
            expect(await baseline.getAttribute("data-saved-timezone")).toBe(A.timezone);
            expect(await baseline.getAttribute("data-saved-leaderboard-opt-out")).toBe("0");
            expect(await page.getByTestId("profile-error").textContent()).toMatch(
              status === 422 ? /valid IANA timezone/ : /try again/i,
            );
            if (status === 422) {
              expect(await page.locator("#profile-timezone").getAttribute("aria-invalid")).toBe(
                "true",
              );
            }

            const beforeCancel = requests.length;
            await page.getByTestId("profile-cancel").click();
            await expectSavedEditor(page);
            expect(writes).toEqual([{ method: "POST", status }]);
            expect(save).toHaveBeenCalledTimes(attemptedSaves);
            expect(await store.find(ID)).toMatchObject({
              bio: A.bio,
              games: A.games,
              timezone: A.timezone,
              leaderboardOptOut: false,
            });
            const recovery = requests.slice(beforeCancel);
            if (javaScriptEnabled) {
              expect(recovery).toEqual([]);
              await expect.poll(() => activeTestId(page)).toBe("profile-name");
            } else {
              expect(recovery).toHaveLength(1);
              expect(recovery[0]).toMatchObject({ method: "GET", status: 200 });
              expect(["/profile", `/members/${ID}`]).toContain(recovery[0]!.path);
              expectPrivateEditor(recovery[0]!.cacheControl);
            }
          } finally {
            log.mockRestore();
          }
        });
      }

      for (const activation of ["Control", "Meta", "Shift", "Alt", "middle", "right"] as const) {
        it(`leaves ${activation} Cancel click on native ${status} to the browser without discarding the draft`, async () => {
          const log = vi.spyOn(console, "error").mockImplementation(() => {});
          try {
            const failure =
              status === 503
                ? Object.assign(new Error("fixture connection refused"), { code: "ECONNREFUSED" })
                : undefined;
            const { page, writes, requests, save, store } = await openProfile(true, true, failure);
            const timezone = status === 422 ? B.timezone : CORRECTED_TIMEZONE;
            await reachNativeRefusal(page, timezone);
            expect(writes).toEqual([{ method: "POST", status }]);
            const refusedDraft = {
              bio: B.bio,
              games_text: B.games_text,
              timezone,
              checked: true,
              departurePrevented: true,
            };
            expect(await formState(page)).toEqual(refusedDraft);
            const cancel = page.getByTestId("profile-cancel");
            expect(await cancel.evaluate((link) => link.tagName)).toBe("A");
            expect(await cancel.getAttribute("href")).toBe(`/members/${ID}`);
            const beforeCancel = requests.length;
            await cancel.evaluate((link) => {
              // Observe after the island's handler, then suppress only the browser
              // default so the same document remains available for draft assertions.
              link.ownerDocument.addEventListener(
                "click",
                (event: Event) => {
                  link.setAttribute("data-click-default-prevented", String(event.defaultPrevented));
                  event.preventDefault();
                },
                { once: true },
              );
            });
            if (activation === "middle" || activation === "right") {
              // Native non-primary input emits auxclick/contextmenu, not click.
              // Dispatch a MouseEvent to exercise a non-primary click reaching the binder.
              await cancel.dispatchEvent("click", { button: activation === "middle" ? 1 : 2 });
            } else {
              await cancel.click({ modifiers: [activation] });
            }
            expect.soft(await cancel.getAttribute("data-click-default-prevented")).toBe("false");
            expect(await formState(page)).toEqual(refusedDraft);
            expect(await page.getByTestId("profile-error").textContent()).toMatch(
              status === 422 ? /valid IANA timezone/ : /try again/i,
            );
            expect(await page.locator("#profile-bio-count").textContent()).toBe(
              "14 of 1000 characters",
            );
            expect(await page.locator("#profile-games-text-count").textContent()).toBe(
              "2 of 20 games, 30 of 1700 characters",
            );
            expect(requests).toHaveLength(beforeCancel);
            expect(writes).toEqual([{ method: "POST", status }]);
            expect(save).toHaveBeenCalledTimes(status === 503 ? 1 : 0);
            expect(await store.find(ID)).toMatchObject({
              bio: A.bio,
              games: A.games,
              timezone: A.timezone,
              leaderboardOptOut: false,
            });
          } finally {
            log.mockRestore();
          }
        });
      }
    }

    it("ordinary no-JS GET Cancel still resets every control locally without a write or navigation", async () => {
      const { page, requests, writes, save, store } = await openProfile(false);
      expectPrivateEditor(requests[0]!.cacheControl);
      await setField(page, "bio", B.bio);
      await setField(page, "games_text", B.games_text);
      await setField(page, "timezone", B.timezone);
      await page.locator("#profile-leaderboard-opt-out").check();
      expect(await formState(page)).toMatchObject({
        bio: B.bio,
        games_text: B.games_text,
        timezone: B.timezone,
        checked: true,
      });
      const beforeCancel = requests.length;
      await page.getByTestId("profile-cancel").click();
      await expectSavedEditor(page);
      expect(requests).toHaveLength(beforeCancel);
      expect(writes).toEqual([]);
      expect(save).not.toHaveBeenCalled();
      expect(await store.find(ID)).toMatchObject({
        bio: A.bio,
        games: A.games,
        timezone: A.timezone,
        leaderboardOptOut: false,
      });
    });

    type KitRefusal = {
      status: 422 | 503;
      errors: Record<string, string>;
      timezone: string;
      savedOptOut: boolean;
      refusedOptOut: boolean;
    };
    const kitRefusals: KitRefusal[] = [
      {
        status: 422,
        errors: { timezone: "Choose a valid IANA timezone, e.g. Europe/London." },
        timezone: B.timezone,
        savedOptOut: false,
        refusedOptOut: true,
      },
      {
        status: 503,
        errors: { save: "We couldn't save your profile. Please try again." },
        timezone: CORRECTED_TIMEZONE,
        savedOptOut: true,
        refusedOptOut: false,
      },
    ];

    // Exercise ProfileView's public props with real Svelte SSR, not Hono HTML
    // relabelled as Kit. Only the document transport is synthetic: a refusal
    // serves B over saved A, and a clean member GET serves A without values/errors.
    async function openKitProfile(
      javaScriptEnabled: boolean,
      {
        refusal,
        artifact = "shipped",
        errors,
        isOwner = true,
      }: {
        refusal?: KitRefusal;
        artifact?: "source" | "shipped";
        errors?: Record<string, string> | null;
        isOwner?: boolean;
      } = {},
    ) {
      const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
      contexts.push(context);
      const page = await context.newPage();
      const pageErrors: string[] = [];
      const requests: { method: string; path: string; status: number }[] = [];
      const profilePath = `/members/${ID}`;
      const savedOptOut = refusal?.savedOptOut ?? false;
      const member = {
        id: ID,
        username: "alice",
        avatar: null,
        bio: A.bio,
        games: [...A.games],
        timezone: A.timezone,
        leaderboardOptOut: savedOptOut,
      };
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== env.APP_URL) return route.abort();
        if (request.method() !== "GET") {
          requests.push({ method: request.method(), path: url.pathname, status: 500 });
          return route.fulfill({ status: 500, body: "Unexpected profile mutation" });
        }
        if (/^\/islands\/[a-z0-9-]+\.js$/.test(url.pathname))
          return route.fulfill({
            contentType: "text/javascript",
            body: readFileSync(
              (artifact === "source" ? "assets" : "public") + url.pathname,
              "utf8",
            ),
          });
        if (url.pathname.endsWith(".css"))
          return route.fulfill({
            contentType: "text/css",
            body: readFileSync("public" + url.pathname, "utf8"),
          });
        if (url.pathname !== profilePath) {
          if (["document", "fetch", "xhr"].includes(request.resourceType()))
            requests.push({ method: "GET", path: url.pathname + url.search, status: 204 });
          return route.fulfill({ status: 204 });
        }
        const rejected = refusal && url.searchParams.get("refused") === String(refusal.status);
        const status = rejected ? refusal.status : 200;
        requests.push({ method: "GET", path: url.pathname + url.search, status });
        return route.fulfill({
          status,
          contentType: "text/html; charset=utf-8",
          body: renderKit({
            member,
            stats: null,
            isOwner,
            isModerator: false,
            appUrl: env.APP_URL,
            joinResult: null,
            errors: rejected ? refusal.errors : errors,
            values: rejected
              ? {
                  bio: B.bio,
                  games_text: B.games_text,
                  timezone: refusal.timezone,
                  leaderboard_opt_out: refusal.refusedOptOut,
                }
              : undefined,
          }),
        });
      });
      const response = await page.goto(
        env.APP_URL + profilePath + (refusal ? `?refused=${refusal.status}` : ""),
      );
      expect(response?.status()).toBe(refusal?.status ?? 200);
      expect(pageErrors).toEqual([]);
      return { page, requests, pageErrors, profilePath, savedOptOut };
    }

    async function expectKitDraft(page: Page, refusal: KitRefusal, enhanced: boolean) {
      await expect
        .poll(() => formState(page))
        .toEqual({
          bio: B.bio,
          games_text: B.games_text,
          timezone: refusal.timezone,
          checked: refusal.refusedOptOut,
          departurePrevented: enhanced,
        });
      expect(await page.getByTestId("profile-error").textContent()).toContain(
        Object.values(refusal.errors)[0],
      );
      expect(await page.locator("#profile-bio-count").textContent()).toBe("14 of 1000 characters");
      expect(await page.locator("#profile-games-text-count").textContent()).toBe(
        "2 of 20 games, 29 of 1700 characters",
      );
      const baseline = page.locator("[data-saved-bio]");
      expect(await baseline.getAttribute("data-saved-bio")).toBe(A.bio);
      expect(await baseline.getAttribute("data-saved-games-text")).toBe(A.games_text);
      expect(await baseline.getAttribute("data-saved-timezone")).toBe(A.timezone);
      expect(await baseline.getAttribute("data-saved-leaderboard-opt-out")).toBe(
        refusal.savedOptOut ? "1" : "0",
      );
      if (refusal.status === 422)
        expect(await page.locator("#profile-timezone").getAttribute("aria-invalid")).toBe("true");
    }

    for (const refusal of kitRefusals) {
      it(`Kit/no-JS Cancel on ${refusal.status} GETs the saved member and discards every refused field`, async () => {
        const { page, requests, pageErrors, profilePath, savedOptOut } = await openKitProfile(
          false,
          {
            refusal,
          },
        );
        await expectKitDraft(page, refusal, false);
        const cancel = page.getByTestId("profile-cancel");
        expect.soft(await cancel.evaluate((node) => node.tagName)).toBe("A");
        expect.soft(await cancel.getAttribute("href")).toBe(profilePath);
        const beforeCancel = requests.length;
        await cancel.click();
        expect
          .soft(requests.slice(beforeCancel))
          .toEqual([{ method: "GET", path: profilePath, status: 200 }]);
        await expectSavedEditor(page, savedOptOut);
        expect(page.url()).toBe(env.APP_URL + profilePath);
        expect(pageErrors).toEqual([]);
      });

      it(`Kit/non-owner ${refusal.status} has no editor or Cancel`, async () => {
        const { page, pageErrors } = await openKitProfile(false, { refusal, isOwner: false });
        expect(await page.getByTestId("profile-form").count()).toBe(0);
        expect(await page.getByTestId("profile-cancel").count()).toBe(0);
        expect(
          await page.locator('[name="bio"], [name="games_text"], [name="timezone"]').count(),
        ).toBe(0);
        expect(await page.getByTestId("profile-bio").textContent()).toContain(A.bio);
        expect(pageErrors).toEqual([]);
      });

      for (const artifact of ["source", "shipped"] as const) {
        it(`Kit/${artifact} plain Cancel on ${refusal.status} restores the saved baseline in place with clean errors, counts and focus`, async () => {
          const { page, requests, pageErrors, savedOptOut } = await openKitProfile(true, {
            refusal,
            artifact,
          });
          await expectKitDraft(page, refusal, true);
          const beforeCancel = requests.length;
          await page.getByTestId("profile-cancel").click();
          await expectSavedEditor(page, savedOptOut);
          await expect.poll(() => activeTestId(page)).toBe("profile-name");
          expect(requests.slice(beforeCancel)).toEqual([]);
          expect(pageErrors).toEqual([]);
        });

        for (const activation of ["Control", "Meta", "Shift", "Alt", "middle", "right"] as const) {
          it(`Kit/${artifact} ${activation} Cancel on ${refusal.status} preserves native link behavior and the refused draft`, async () => {
            const { page, requests, pageErrors, profilePath } = await openKitProfile(true, {
              refusal,
              artifact,
            });
            await expectKitDraft(page, refusal, true);
            const cancel = page.getByTestId("profile-cancel");
            expect(await cancel.evaluate((node) => node.tagName)).toBe("A");
            expect(await cancel.getAttribute("href")).toBe(profilePath);
            const beforeCancel = requests.length;
            await cancel.evaluate((link) => {
              // Observe the real binder before suppressing only the browser
              // default, leaving this document available for draft assertions.
              link.ownerDocument.addEventListener(
                "click",
                (event: Event) => {
                  link.setAttribute("data-click-default-prevented", String(event.defaultPrevented));
                  event.preventDefault();
                },
                { once: true },
              );
            });
            if (activation === "middle" || activation === "right") {
              await cancel.dispatchEvent("click", { button: activation === "middle" ? 1 : 2 });
            } else {
              await cancel.click({ modifiers: [activation] });
            }
            expect(await cancel.getAttribute("data-click-default-prevented")).toBe("false");
            await expectKitDraft(page, refusal, true);
            expect(requests.slice(beforeCancel)).toEqual([]);
            expect(pageErrors).toEqual([]);
          });
        }
      }
    }

    for (const fresh of [
      { label: "omitted", errors: undefined },
      { label: "null", errors: null },
      { label: "empty", errors: {} },
    ]) {
      it(`Kit/no-JS fresh GET with ${fresh.label} errors keeps Cancel as a local native reset`, async () => {
        const { page, requests, pageErrors } = await openKitProfile(false, {
          errors: fresh.errors,
        });
        const cancel = page.getByTestId("profile-cancel");
        expect(await cancel.evaluate((node) => node.tagName)).toBe("BUTTON");
        expect(await cancel.getAttribute("type")).toBe("reset");
        await setField(page, "bio", B.bio);
        await setField(page, "games_text", B.games_text);
        await setField(page, "timezone", B.timezone);
        await page.locator("#profile-leaderboard-opt-out").check();
        expect(await formState(page)).toMatchObject({
          bio: B.bio,
          games_text: B.games_text,
          timezone: B.timezone,
          checked: true,
        });
        const beforeCancel = requests.length;
        await cancel.click();
        await expectSavedEditor(page);
        expect(requests.slice(beforeCancel)).toEqual([]);
        expect(pageErrors).toEqual([]);
      });
    }

    // Delayed island refusals must respect deliberate newer work, as a
    // delayed success does. The PATCH is held at the route until the test
    // releases it, so focus/caret assertions run against the real caret.
    async function holdPatch(page: Page, status: number, body: string) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived!: () => void;
      const seen = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      await page.route("**/members/*", async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        arrived();
        await gate;
        await route.fulfill({ status, contentType: "application/json", body });
      });
      return { seen, release: () => release() };
    }

    const activeName = (page: Page) =>
      page.evaluate<string | null>("document.activeElement?.getAttribute('name') ?? null");
    const activeTestId = (page: Page) =>
      page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? null");

    async function deliberateGamesDraft(page: Page) {
      const games = await field(page, "games_text");
      await games.fill("Newer draft typed after save");
      await games.evaluate((el) => {
        const control = el as unknown as { setSelectionRange: (a: number, b: number) => void };
        control.setSelectionRange(6, 11);
      });
      return games;
    }

    const caret = (games: Awaited<ReturnType<typeof field>>) =>
      games.evaluate((el) => {
        const control = el as unknown as { selectionStart: number; selectionEnd: number };
        return { start: control.selectionStart, end: control.selectionEnd };
      });

    it("keeps real focus, caret and newer draft when a deferred 422 arrives after deliberate editing", async () => {
      const { page } = await openProfile(true, false);
      const held = await holdPatch(
        page,
        422,
        JSON.stringify({ errors: { bio: "Keep your bio to 1000 characters or fewer." } }),
      );
      await setField(page, "bio", "Submitted bio");
      await page.getByTestId("profile-save").click();
      await held.seen;
      const games = await deliberateGamesDraft(page);
      held.release();
      await page.getByTestId("profile-error").waitFor();

      expect(await page.getByTestId("profile-error").getAttribute("role")).toBe("alert");
      expect(await activeName(page)).toBe("games_text");
      expect(await games.inputValue()).toBe("Newer draft typed after save");
      expect(await caret(games)).toEqual({ start: 6, end: 11 });
      const bio = await field(page, "bio");
      expect(await bio.getAttribute("aria-invalid")).toBe("true");
      expect(await bio.getAttribute("aria-describedby")).toContain("profile-bio-error");
    });

    it("keeps real focus, caret and newer draft when a deferred 500 arrives after deliberate editing", async () => {
      const { page } = await openProfile(true, false);
      const held = await holdPatch(page, 500, "");
      await setField(page, "bio", "Submitted bio");
      await page.getByTestId("profile-save").click();
      await held.seen;
      const games = await deliberateGamesDraft(page);
      held.release();
      await page.getByTestId("profile-save-failed").waitFor();

      expect(await page.getByTestId("profile-save-failed").getAttribute("role")).toBe("alert");
      expect(await activeName(page)).toBe("games_text");
      expect(await games.inputValue()).toBe("Newer draft typed after save");
      expect(await caret(games)).toEqual({ start: 6, end: 11 });
    });

    it("focuses the real error summary when a deferred 422 is uninterrupted", async () => {
      const { page } = await openProfile(true, false);
      const held = await holdPatch(
        page,
        422,
        JSON.stringify({ errors: { bio: "Keep your bio to 1000 characters or fewer." } }),
      );
      await setField(page, "bio", "Submitted bio");
      await page.getByTestId("profile-save").click();
      await held.seen;
      held.release();
      await page.getByTestId("profile-error").waitFor();

      expect(await activeTestId(page)).toBe("profile-error");
      expect(await (await field(page, "bio")).inputValue()).toBe("Submitted bio");
    });
  },
);
