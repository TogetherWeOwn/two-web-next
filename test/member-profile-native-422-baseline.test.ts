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
// runs on the real profiles routes, the real SSR page and the shipped
// public/islands/member-profile.js binder over in-memory stores and an
// ephemeral loopback server. No database, staging identity or external
// service is used.
//
// The browser cases are opt-in where Chromium is installed:
// A11Y_BROWSER_TESTS=true npx vitest run test/member-profile-native-422-baseline.test.ts
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { registerProfileParticipationBrowserCases } from "./helpers/profile-participation-browser";
import { registerProfileAttendedHistoryBrowserCases } from "./helpers/profile-attended-history-browser";

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

async function setup() {
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
    registerProfileAttendedHistoryBrowserCases();
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    const servers: Server[] = [];
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
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

    async function openProfile(javaScriptEnabled: boolean, withholdIslandUntilWrite = true) {
      const fixture = await setup();
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
      return { ...fixture, page, writes, base };
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

    // Drive the real native flow: type B on the GET form (island withheld),
    // submit, and land on the server-rendered 422 page with the island live.
    async function reachNative422(page: Page) {
      await setField(page, "bio", B.bio);
      await setField(page, "games_text", B.games_text);
      await setField(page, "timezone", B.timezone);
      await page.locator("#profile-leaderboard-opt-out").check();
      await Promise.all([page.waitForNavigation(), page.getByTestId("profile-save").click()]);
      await page.getByTestId("profile-error").waitFor();
    }

    it("treats the rejected draft as unsaved work on the 422 page and Cancel restores the stored profile", async () => {
      const { page, writes, save } = await openProfile(true);
      await reachNative422(page);
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
      await reachNative422(page);

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
      await reachNative422(page);
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
