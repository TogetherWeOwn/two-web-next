// Composition-limits acceptance: real routes and real Chromium.
//
// Route level (always runs): GET /profile and the native 422 re-render carry
// the persistent hints and seeded counts from
// test/profile-composition-hints.test.ts through the real routes.
//
// Browser level (opt-in where Chromium is installed):
// A11Y_BROWSER_TESTS=true npx vitest run test/profile-composition-browser.test.ts
// Ephemeral loopback fixtures serve the real SSR page, the shipped binder and
// in-memory stores. No live database, staging identity or external service.
// Typing updates counts with zero PATCH requests, reset and accepted-save
// normalization refresh them, and error cleanup keeps the persistent hints.
//
// Failing-first Test Author handoff: the hint/count locators below do not
// exist until the Builder lands the change. Builder must not edit this file;
// defects return as a bounded follow-up.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect as expectBrowser } from "@playwright/test";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const ID = "100000000000000001";
const env = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;

const BIO_HINT_ID = "profile-bio-hint";
const BIO_COUNT_ID = "profile-bio-count";
const GAMES_HINT_ID = "profile-games-text-hint";
const GAMES_COUNT_ID = "profile-games-text-count";
const BIO_HINT_COPY = "Up to 1000 characters.";
const GAMES_HINT_COPY =
  "Up to 20 games, one per line: 80 characters per game, 1700 characters total.";
// Stored fixture below: bio "Stored bio", games ["Stored Game"].
const STORED_BIO_COUNT = "10 of 1000 characters";
const STORED_GAMES_COUNT = "1 of 20 games, 11 of 1700 characters";

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
  const store = createMemoryProfileStore([
    {
      id: ID,
      username: "alice",
      avatar: null,
      bio: "Stored bio",
      games: ["Stored Game"],
      timezone: "Europe/London",
      leaderboardOptOut: false,
      joinedAt: new Date("2024-03-15T00:00:00Z"),
    },
  ]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  return { app, cookie, store, save };
}

describe("composition hints through the real routes (no-JS HTML)", () => {
  it("GET /profile renders hints, seeded counts and hint+count association", async () => {
    const { app, cookie } = await setup();
    const res = await app.request("/profile", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`id="${BIO_HINT_ID}"`);
    expect(html).toContain(BIO_HINT_COPY);
    expect(html).toContain(`id="${BIO_COUNT_ID}">${STORED_BIO_COUNT}</p>`);
    expect(html).toContain(`id="${GAMES_HINT_ID}"`);
    expect(html).toContain(GAMES_HINT_COPY);
    expect(html).toContain(`id="${GAMES_COUNT_ID}">${STORED_GAMES_COUNT}</p>`);
    const bioTag = html.match(/<textarea\b[^>]*\bid="profile-bio"[^>]*>/)?.[0] ?? "";
    expect(bioTag).toContain(`aria-describedby="${BIO_HINT_ID} ${BIO_COUNT_ID}"`);
    expect(bioTag).not.toMatch(/maxlength/i);
    const gamesTag = html.match(/<textarea\b[^>]*\bid="profile-games-text"[^>]*>/)?.[0] ?? "";
    expect(gamesTag).toContain(`aria-describedby="${GAMES_HINT_ID} ${GAMES_COUNT_ID}"`);
    expect(gamesTag).not.toMatch(/maxlength/i);
    // Helper text above the field; errors still hug their label (see below).
    expect(html).toMatch(
      new RegExp(`<p\\b[^>]*\\bid="${BIO_HINT_ID}"[^>]*>[\\s\\S]*?</p>\\s*<label\\b`),
    );
  });

  it("native 422 re-render counts the rejected draft, keeping hints and error adjacency", async () => {
    const { app, cookie, save } = await setup();
    const res = await app.request(
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
          bio: "a".repeat(1001),
          games_text: "Go\nGo\n\nChess",
          timezone: "UTC",
        }).toString(),
      },
      env,
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(`id="${BIO_COUNT_ID}">1001 of 1000 characters (1 over the limit)</p>`);
    expect(html).toContain(`id="${GAMES_COUNT_ID}">2 of 20 games, 12 of 1700 characters</p>`);
    const bioTag = html.match(/<textarea\b[^>]*\bid="profile-bio"[^>]*>/)?.[0] ?? "";
    expect(bioTag).toContain(`aria-describedby="${BIO_HINT_ID} ${BIO_COUNT_ID} profile-bio-error"`);
    const gamesTag = html.match(/<textarea\b[^>]*\bid="profile-games-text"[^>]*>/)?.[0] ?? "";
    expect(gamesTag).toContain(`aria-describedby="${GAMES_HINT_ID} ${GAMES_COUNT_ID}"`);
    expect(gamesTag).not.toContain("profile-games-text-error");
    expect(html).toMatch(/<\/label><p id="profile-bio-error"/);
    expect(save).not.toHaveBeenCalled();
  });
});

// Real Chromium over the real SSR page and shipped binder.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "composition feedback in a real browser",
  () => {
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

    async function openProfile(javaScriptEnabled: boolean) {
      const fixture = await setup();
      const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
      contexts.push(context);
      const writes: { method: string; status: number; body: string }[] = [];
      const patches: string[] = [];
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
            writes.push({ method: request.method!, status: response.status, body: input });
          }
          reply.writeHead(response.status, Object.fromEntries(response.headers));
          reply.end(body);
        } catch (error) {
          console.error(error);
          reply.writeHead(500);
          reply.end("fixture error");
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
      // Contain all page traffic to its ephemeral fixture, including redirects.
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      page.on("request", (request) => {
        if (request.method() === "PATCH") patches.push(request.url());
      });
      await page.goto(`${base}/profile`);
      return { ...fixture, page, writes, patches };
    }

    // Polls until the count settles: input updates are synchronous, while
    // the reset refresh lands on a task after the native restore.
    async function expectCount(page: Page, id: string, text: string) {
      await expectBrowser(page.locator(`#${id}`)).toHaveText(text);
    }

    // Real user-edit input respects native maxlength, unlike assigning .value,
    // so the inputValue assertion below doubles as a no-maxlength proof.
    async function setText(page: Page, name: string, value: string) {
      const control = page.locator(`[name="${name}"]`);
      await control.fill("");
      await control.focus();
      await page.keyboard.insertText(value);
      expect(await control.inputValue()).toBe(value);
    }

    it("no-JS page shows persistent hints with seeded counts and no maxlength", async () => {
      const { page } = await openProfile(false);
      await expectCount(page, BIO_HINT_ID, BIO_HINT_COPY);
      await expectCount(page, BIO_COUNT_ID, STORED_BIO_COUNT);
      await expectCount(page, GAMES_HINT_ID, GAMES_HINT_COPY);
      await expectCount(page, GAMES_COUNT_ID, STORED_GAMES_COUNT);
      expect(await page.locator("#profile-bio").getAttribute("aria-describedby")).toBe(
        `${BIO_HINT_ID} ${BIO_COUNT_ID}`,
      );
      expect(await page.locator("#profile-games-text").getAttribute("aria-describedby")).toBe(
        `${GAMES_HINT_ID} ${GAMES_COUNT_ID}`,
      );
      expect(await page.locator("#profile-bio").getAttribute("maxlength")).toBeNull();
      expect(await page.locator("#profile-games-text").getAttribute("maxlength")).toBeNull();
    });

    it("typing refreshes counts with zero PATCH requests and no truncation", async () => {
      const { page, writes, patches } = await openProfile(true);
      // Textareas normalize CR/CRLF to LF on input, so the browser covers LF
      // while the island suite pins CR/CRLF splitting against the validator.
      await setText(page, "bio", "hi 🎮");
      await expectCount(page, BIO_COUNT_ID, "4 of 1000 characters");
      await setText(page, "games_text", "Go\nGo\ngo");
      await expectCount(page, GAMES_COUNT_ID, "2 of 20 games, 8 of 1700 characters");
      await setText(page, "bio", "b".repeat(1001));
      await expectCount(page, BIO_COUNT_ID, "1001 of 1000 characters (1 over the limit)");
      const games21 = Array.from({ length: 21 }, (_, i) => `game${i}`).join("\n");
      await setText(page, "games_text", games21);
      await expectCount(
        page,
        GAMES_COUNT_ID,
        "21 of 20 games (1 over the limit), 136 of 1700 characters",
      );
      expect(await page.locator('[name="bio"]').inputValue()).toHaveLength(1001);
      expect(patches).toHaveLength(0);
      expect(writes).toHaveLength(0);
    });

    it("typing announces nothing: no live region appears or changes", async () => {
      const { page } = await openProfile(true);
      const liveCount = () =>
        page.evaluate("document.querySelectorAll('[aria-live],[role=alert],[role=status]').length");
      expect(await liveCount()).toBe(0);
      await setText(page, "bio", "hello");
      await setText(page, "games_text", "a\nb");
      await setText(page, "bio", "b".repeat(1001));
      expect(await liveCount()).toBe(0);
      expect(await page.locator(`#${BIO_COUNT_ID}`).getAttribute("aria-live")).toBeNull();
      expect(await page.locator(`#${BIO_COUNT_ID}`).getAttribute("role")).toBeNull();
      expect(await page.locator(`#${GAMES_COUNT_ID}`).getAttribute("aria-live")).toBeNull();
      expect(await page.locator(`#${GAMES_COUNT_ID}`).getAttribute("role")).toBeNull();
    });

    it("Cancel restores the stored values and their counts", async () => {
      const { page } = await openProfile(true);
      await setText(page, "bio", "b".repeat(1001));
      await setText(page, "games_text", "Draft game");
      await page.getByTestId("profile-cancel").click();
      await expectCount(page, BIO_COUNT_ID, STORED_BIO_COUNT);
      await expectCount(page, GAMES_COUNT_ID, STORED_GAMES_COUNT);
      expect(await page.locator('[name="bio"]').inputValue()).toBe("Stored bio");
      expect(await page.locator('[name="games_text"]').inputValue()).toBe("Stored Game");
    });

    it("an accepted save normalizes values and refreshes counts", async () => {
      const { page, writes } = await openProfile(true);
      await setText(page, "bio", "Saved bio ");
      await setText(page, "games_text", "Go\nChess\n");
      await page.getByTestId("profile-save").click();
      await page.getByTestId("profile-saved").waitFor();
      expect(writes).toHaveLength(1);
      await expectCount(page, BIO_COUNT_ID, "9 of 1000 characters");
      await expectCount(page, GAMES_COUNT_ID, "2 of 20 games, 8 of 1700 characters");
      await expectCount(page, BIO_HINT_ID, BIO_HINT_COPY);
      await expectCount(page, GAMES_HINT_ID, GAMES_HINT_COPY);
    });

    it("a refused save keeps hints and counts; the correction clears errors only", async () => {
      const { page, writes } = await openProfile(true);
      await setText(page, "bio", "c".repeat(1001));
      await page.getByTestId("profile-save").click();
      await page.getByTestId("profile-error").waitFor();
      expect(writes).toHaveLength(0);
      expect(await page.locator("#profile-bio").getAttribute("aria-describedby")).toBe(
        `${BIO_HINT_ID} ${BIO_COUNT_ID} profile-bio-error`,
      );
      await expectCount(page, BIO_HINT_ID, BIO_HINT_COPY);
      await expectCount(page, BIO_COUNT_ID, "1001 of 1000 characters (1 over the limit)");
      await setText(page, "bio", "Fixed bio");
      await page.getByTestId("profile-save").click();
      await page.getByTestId("profile-saved").waitFor();
      expect(writes).toHaveLength(1);
      expect(await page.getByTestId("profile-error").count()).toBe(0);
      expect(await page.locator("#profile-bio").getAttribute("aria-describedby")).toBe(
        `${BIO_HINT_ID} ${BIO_COUNT_ID}`,
      );
      await expectCount(page, BIO_COUNT_ID, "9 of 1000 characters");
      await expectCount(page, BIO_HINT_ID, BIO_HINT_COPY);
    });
  },
);
