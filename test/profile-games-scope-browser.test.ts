// GS-06..GS-10: real routes, executed Kit SSR and shipped island in Chromium.
// Always: npx vitest run test/profile-games-scope-browser.test.ts
// Browser: A11Y_BROWSER_TESTS=true npx vitest run test/profile-games-scope-browser.test.ts
// Root/web dev deps and `npx playwright install chromium` are prerequisites.
// All HTTP is intercepted into local memory fixtures; no DB, Discord or live user.
// These author-owned tests must be consumed unchanged with the implementation.
import { readFileSync } from "node:fs";
import { expect as browserExpect } from "@playwright/test";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { sameOrigin } from "../src/same-origin";
import {
  compileGamesScopeKit,
  gamesDescriptionIds,
  gamesScopeLinkName,
  gamesScopeMeanings,
  gamesScopeMember,
  gamesScopeOrigin,
  scopeNode,
  scopeText,
} from "./helpers/profile-games-scope";

const env = {
  APP_URL: gamesScopeOrigin,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const memberPath = `/members/${gamesScopeMember.id}`;

async function fixture() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: gamesScopeMember.id,
    username: gamesScopeMember.username,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const signed = await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  const cookie = signed.split(";")[0]!;
  const store = createMemoryProfileStore([{ ...gamesScopeMember }]);
  const save = vi.spyOn(store, "save");
  // The production parent supplies sameOrigin; the isolated sub-app does not.
  const app = new Hono<{ Bindings: Env }>().use("*", sameOrigin).route(
    "/",
    profilesApp({
      sessionStore: sessions,
      store,
      accessLog: async () => true,
      throttle: async () => ({ limited: false }),
    }),
  );
  return { app, cookie, store, save };
}

function postBody(games: string) {
  return new URLSearchParams({
    _method: "PATCH",
    [PROFILE_HONEY_FIELD]: "",
    [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000),
    bio: "Stored bio",
    games_text: games,
    timezone: "UTC",
    leaderboard_opt_out: "0",
  }).toString();
}

it("GS-06 real native 422 retains the submitted games, guidance and field error without saving", async () => {
  const f = await fixture();
  const games = Array.from({ length: 21 }, (_, i) => `Game ${i}`).join("\n");
  const response = await f.app.request(
    memberPath,
    {
      method: "POST",
      headers: {
        cookie: f.cookie,
        origin: gamesScopeOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: postBody(games),
    },
    env,
  );
  expect(response.status).toBe(422);
  const html = await response.text();
  expect(f.save).not.toHaveBeenCalled();
  expect(scopeNode(html, "profile-games-text")).toContain(games);
  expect(gamesDescriptionIds(html)).toContain("profile-games-text-error");
  const text = scopeText(
    gamesDescriptionIds(html)
      .map((id) => scopeNode(html, id))
      .join(" "),
  );
  for (const meaning of gamesScopeMeanings) expect(text).toMatch(meaning);
});

it("GS-07 CONTROL native normalization still writes website columns once", async () => {
  const f = await fixture();
  const response = await f.app.request(
    memberPath,
    {
      method: "POST",
      headers: {
        cookie: f.cookie,
        origin: gamesScopeOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: postBody(" Go\r\nGo\r\n\r\nChess "),
    },
    env,
  );
  expect(response.status).toBe(303);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.save).toHaveBeenCalledWith(gamesScopeMember.id, {
    bio: "Stored bio",
    games: ["Go", "Chess"],
    timezone: "UTC",
    leaderboardOptOut: false,
  });
  expect(f.store.rows.get(gamesScopeMember.id)?.games).toEqual(["Go", "Chess"]);
});

// Same opt-in as the existing composition browser suite; root Vitest inventory
// discovers this file even on machines without Chromium. The Builder's CI step
// must execute this command with A11Y_BROWSER_TESTS=true, not count skips green.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")("Games scope in real Chromium", () => {
  let browser: Browser;
  let kit: Awaited<ReturnType<typeof compileGamesScopeKit>>;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    kit = await compileGamesScopeKit();
  });
  afterAll(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    await browser?.close();
  });

  async function open(renderer: "Hono" | "Kit", javaScriptEnabled = true) {
    const f = await fixture();
    const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
    contexts.push(context);
    const equals = f.cookie.indexOf("=");
    await context.addCookies([
      {
        name: f.cookie.slice(0, equals),
        value: f.cookie.slice(equals + 1),
        url: gamesScopeOrigin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const writes: { method: string; body: string; status: number }[] = [];
    const requests: string[] = [];
    const failures: string[] = [];
    let hold: null | (() => Promise<void>) = null;
    let refuseOrigin = false;
    const assets: Record<string, [string, string]> = {
      "/islands/member-profile.js": ["public/islands/member-profile.js", "text/javascript"],
      "/islands/avatar.js": ["public/islands/avatar.js", "text/javascript"],
      "/styles.css": ["public/styles.css", "text/css"],
      "/theme.css": ["public/theme.css", "text/css"],
      "/profile-theme.css": ["public/profile-theme.css", "text/css"],
    };
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}`);
      try {
        if (url.origin !== gamesScopeOrigin) {
          failures.push(`unexpected external ${url.origin}`);
          await route.abort();
          return;
        }
        const asset = assets[url.pathname];
        if (asset) {
          await route.fulfill({ status: 200, contentType: asset[1], body: readFileSync(asset[0]) });
          return;
        }
        if (url.pathname === "/discord") {
          // Stops at the existing app destination; never follows a Discord invite.
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><title>Discord destination fixture</title>",
          });
          return;
        }
        if (url.pathname !== "/profile" && url.pathname !== memberPath) {
          await route.fulfill({ status: 204 });
          return;
        }
        const response = await f.app.request(
          url.href,
          {
            method: request.method(),
            headers:
              refuseOrigin && request.method() === "PATCH"
                ? { ...request.headers(), origin: "https://foreign.example.test" }
                : request.headers(),
            body: request.postData() ?? undefined,
          },
          env,
        );
        let body = await response.text();
        if (renderer === "Kit" && request.method() === "GET" && response.status === 200) {
          body = `<!doctype html><html lang="en"><head><title>Profile fixture</title></head><body>${kit.profile()}</body></html>`;
        }
        // Model ordinary editing dwell time, preserving the honeypot contract.
        body = body.replace(
          new RegExp(`(name="${PROFILE_OPENED_AT_FIELD}" value=")[^"]+`),
          (_, prefix) => prefix + String(Date.now() - 5000),
        );
        if (request.method() !== "GET") {
          writes.push({
            method: request.method(),
            body: request.postData() ?? "",
            status: response.status,
          });
          const pending = hold;
          hold = null;
          if (pending) await pending();
        }
        const headers = Object.fromEntries(response.headers);
        await route.fulfill({ status: response.status, headers, body });
      } catch (error) {
        failures.push(String(error));
        await route.fulfill({ status: 500, body: "fixture setup error" });
      }
    });
    const page = await context.newPage();
    await page.goto(`${gamesScopeOrigin}/profile`);
    await browserExpect(page.getByTestId("profile-form")).toBeVisible();
    expect(failures, "fixture is healthy before contract assertions").toEqual([]);
    return {
      ...f,
      page,
      writes,
      requests,
      failures,
      refuseNextSave() {
        refuseOrigin = true;
      },
      holdNext() {
        let release!: () => void;
        let seen!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          seen = resolve;
        });
        hold = async () => {
          seen();
          await gate;
        };
        return { release, started };
      },
    };
  }

  async function expectScope(page: Page) {
    const control = page.locator("#profile-games-text");
    const ids =
      (await control.getAttribute("aria-describedby"))?.split(/\s+/).filter(Boolean) ?? [];
    expect(ids).toEqual(
      expect.arrayContaining(["profile-games-text-hint", "profile-games-text-count"]),
    );
    const text = (
      await Promise.all(
        ids.map(async (id) => {
          const node = page.locator(`[id="${id}"]`);
          await browserExpect(node).toBeVisible();
          return node.innerText();
        }),
      )
    ).join(" ");
    for (const meaning of gamesScopeMeanings) expect(text).toMatch(meaning);
    await browserExpect(
      page.getByTestId("profile-form").getByRole("link", { name: gamesScopeLinkName, exact: true }),
    ).toHaveAttribute("href", "/discord");
    await browserExpect(control).toHaveAccessibleName("Games (one per line)");
  }

  for (const renderer of ["Hono", "Kit"] as const) {
    it(`GS-08 ${renderer} no-JS editor provides associated guidance and a keyboard-native link`, async () => {
      const f = await open(renderer, false);
      await expectScope(f.page);
      const link = f.page
        .getByTestId("profile-form")
        .getByRole("link", { name: gamesScopeLinkName, exact: true });
      await f.page.locator("#profile-games-text").focus();
      // Tab through the real document rather than setting focus on the link.
      let reached = false;
      for (let i = 0; i < 30; i++) {
        await f.page.keyboard.press("Tab");
        if (await link.evaluate((node) => node === node.ownerDocument.activeElement)) {
          reached = true;
          break;
        }
      }
      expect(reached, "role link participates in native tab order").toBe(true);
      await Promise.all([f.page.waitForURL("**/discord"), f.page.keyboard.press("Enter")]);
      expect(f.writes).toEqual([]);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.failures).toEqual([]);
    });

    it(`GS-09 ${renderer} guidance survives client validation and a refused server save`, async () => {
      const f = await open(renderer);
      await f.page
        .locator("#profile-games-text")
        .fill(Array.from({ length: 21 }, (_, i) => `Game ${i}`).join("\n"));
      await f.page.getByTestId("profile-save").click();
      await browserExpect(f.page.getByTestId("profile-error")).toBeVisible();
      expect(f.writes).toHaveLength(0);
      await browserExpect(f.page.locator("#profile-games-text")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      // Snapshot the invalid state's real descriptions before correcting it;
      // defer the new-feature assertions so refusal also executes on the base.
      const invalidIds = (await f.page
        .locator("#profile-games-text")
        .getAttribute("aria-describedby"))!.split(/\s+/);
      const invalidText = (
        await Promise.all(invalidIds.map((id) => f.page.locator(`[id="${id}"]`).innerText()))
      ).join(" ");
      await f.page.locator("#profile-games-text").fill("Go\nChess");
      // Feed a foreign Origin into the real route, not a fabricated response.
      // route.fallback header overrides do not change request.headers() in the
      // lower fixture handler, so inject at its app.request boundary explicitly.
      f.refuseNextSave();
      await f.page.getByTestId("profile-save").click();
      await browserExpect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0]!.status).toBe(403);
      await browserExpect(f.page.getByTestId("profile-save-failed")).toBeVisible();
      await browserExpect(f.page.getByTestId("profile-save-failed")).toHaveAttribute(
        "role",
        "alert",
      );
      expect(f.save).not.toHaveBeenCalled();
      await browserExpect(f.page.locator("#profile-games-text")).toHaveValue("Go\nChess");
      expect(f.failures).toEqual([]);
      for (const meaning of gamesScopeMeanings) expect(invalidText).toMatch(meaning);
      await expectScope(f.page);
    });

    it(`GS-09 ${renderer} guidance survives a stale success while the newer draft stays dirty`, async () => {
      const f = await open(renderer);
      const held = f.holdNext();
      try {
        await f.page.locator("#profile-games-text").fill("Go");
        await f.page.getByTestId("profile-save").click();
        await held.started;
        await f.page.locator("#profile-games-text").fill("Newer draft");
        held.release();
        await browserExpect(f.page.getByTestId("profile-saved")).toBeVisible();
        await browserExpect(f.page.getByTestId("profile-saved")).toHaveAttribute("role", "status");
        await browserExpect(f.page.getByTestId("profile-save")).toBeEnabled();
        await browserExpect(f.page.locator("#profile-games-text")).toHaveValue("Newer draft");
        expect(f.save).toHaveBeenCalledTimes(1);
        expect(f.writes).toHaveLength(1);
        const dialogPromise = f.page.waitForEvent("dialog");
        const click = f.page
          .getByRole("link", { name: "Your profile", exact: true })
          .first()
          .click();
        const dialog = await dialogPromise;
        expect(dialog.type()).toBe("beforeunload");
        await dialog.dismiss();
        await click;
        await expectScope(f.page);
      } finally {
        held.release();
      }
    });

    it(`GS-10 ${renderer} dirty Discord departure warns, dismissal retains draft, and does not autosave`, async () => {
      const f = await open(renderer);
      const link = f.page
        .getByTestId("profile-form")
        .getByRole("link", { name: gamesScopeLinkName, exact: true });
      // Fail fast for the absent feature rather than mislabel a timeout as RED.
      expect(await link.count(), "owner role-edit link exists").toBe(1);
      await f.page.locator("#profile-games-text").fill("Unsent draft");
      const before = [...f.requests];
      const dialogPromise = f.page.waitForEvent("dialog");
      const click = link.click();
      const dialog = await dialogPromise;
      expect(dialog.type()).toBe("beforeunload");
      await dialog.dismiss();
      await click;
      await browserExpect(f.page).toHaveURL(`${gamesScopeOrigin}/profile`);
      await browserExpect(f.page.locator("#profile-games-text")).toHaveValue("Unsent draft");
      expect(f.requests).toEqual(before);
      expect(f.writes).toEqual([]);
      expect(f.save).not.toHaveBeenCalled();
      await expectScope(f.page);
      await f.page.getByTestId("profile-cancel").click();
      await Promise.all([f.page.waitForURL("**/discord"), link.click()]);
      expect(f.writes).toEqual([]);
    });

    it(`GS-07 ${renderer} CONTROL typing sends nothing and one save keeps the existing JSON payload`, async () => {
      const f = await open(renderer);
      const before = [...f.requests];
      await f.page.locator("#profile-games-text").fill(" Go\nGo\n\nChess ");
      expect(f.requests).toEqual(before);
      expect(f.writes).toHaveLength(0);
      expect(f.save).not.toHaveBeenCalled();
      await f.page.getByTestId("profile-save").click();
      await browserExpect(f.page.getByTestId("profile-saved")).toBeVisible();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]!.method).toBe("PATCH");
      expect(JSON.parse(f.writes[0]!.body)).toEqual({
        bio: "Stored bio",
        games_text: " Go\nGo\n\nChess ",
        timezone: "UTC",
        leaderboard_opt_out: false,
        [PROFILE_HONEY_FIELD]: "",
        [PROFILE_OPENED_AT_FIELD]: expect.any(Number),
      });
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.store.rows.get(gamesScopeMember.id)?.games).toEqual(["Go", "Chess"]);
      expect(f.requests).toEqual([...before, `PATCH ${memberPath}`]);
      expect(f.failures).toEqual([]);
    });
  }
});
