import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Env } from "../src/env";
import { PROFILE_HONEY_FIELD, PROFILE_OPENED_AT_FIELD, profileClientErrors } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const ID = "100000000000000001";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: "test-session-secret-at-least-32-bytes-long" } as Env;
const alphabets = [
  { name: "BMP", text: (length: number) => "遊".repeat(length), units: 1000 },
  { name: "astral", text: (length: number) => "🎮".repeat(length), units: 2000 },
  { name: "mixed", text: (length: number) => "遊🎮".repeat(Math.floor(length / 2)) + (length % 2 ? "遊" : ""), units: 1500 },
];
const paths = ["native POST", "island PATCH"] as const;
type Fields = { bio: string; games_text: string; timezone: string };

async function setup() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({ tokenHash: await hashToken(token), userId: ID, username: "alice", avatar: null, member: true, moderator: false, expiresAt: new Date(Date.now() + 3600_000) });
  const cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  const member = { id: ID, username: "alice", avatar: null, bio: null, games: [], timezone: null };
  const store = createMemoryProfileStore([member]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({ sessionStore: sessions, store, accessLog: async () => true, throttle: async () => ({ limited: false }) });
  const html = async () => (await app.request("/profile", { headers: { cookie } }, env)).text();
  const submit = (path: typeof paths[number], fields: Fields, trap: Record<string, string> = {}) => {
    const body = { ...fields, [PROFILE_HONEY_FIELD]: "", [PROFILE_OPENED_AT_FIELD]: String(Date.now() - 5000), ...trap };
    return app.request(`/members/${ID}`, path === "native POST" ? {
      method: "POST",
      headers: { cookie, origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _method: "PATCH", ...body }).toString(),
    } : {
      method: "PATCH",
      headers: { cookie, origin: env.APP_URL, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }, env);
  };
  return { app, cookie, store, save, html, submit };
}

function expectCodePointForm(html: string) {
  // HTML maxlength counts UTF-16 units and can stop submission before either
  // code-point validator runs. Omitting it also lets over-limit no-JS input
  // reach the server's established errors instead of being silently truncated.
  for (const name of ["bio", "games_text"]) {
    const textarea = html.match(new RegExp(`<textarea\\b[^>]*name="${name}"[^>]*>`))?.[0];
    expect(textarea).toBeDefined();
    expect(textarea).not.toMatch(/\bmaxlength\s*=/i);
  }
  expect(html).toContain(`<form method="post" action="/members/${ID}"`);
  expect(html).toContain('name="_method" value="PATCH"');
  expect(html).toContain(`name="${PROFILE_HONEY_FIELD}" tabindex="-1" autocomplete="off"`);
  expect(html).toContain(`name="${PROFILE_OPENED_AT_FIELD}"`);
  expect(html).toContain('type="submit" data-testid="profile-save"');
  expect(html).toContain('type="reset" data-testid="profile-cancel"');
}

for (const path of paths) {
  describe(`${path}: code-point boundaries (in-memory fixtures only)`, () => {
    it.each(alphabets)("submits $name boundary values without UTF-16 truncation", async ({ text, units }) => {
      const { html, submit, store, save } = await setup();
      const bio = text(1000);
      const games = Array.from({ length: 20 }, (_, i) => String(i) + text(80 - String(i).length));
      const list = games.join("\n");
      const games_text = list + " ".repeat(1700 - [...list].length);
      const fields = { bio, games_text, timezone: "Europe/London" };
      expect([...bio]).toHaveLength(1000);
      expect(bio.length).toBe(units);
      expect([...games_text]).toHaveLength(1700);
      expect(games.every((game) => [...game].length === 80)).toBe(true);
      expectCodePointForm(await html());
      expect(profileClientErrors(fields)).toEqual({});
      const response = await submit(path, fields);
      expect(response.status).toBe(path === "native POST" ? 303 : 200);
      if (path === "native POST") expect(response.headers.get("location")).toBe(`/members/${ID}`);
      else expect(await response.json()).toEqual({ saved: true, message: "Profile saved." });
      expect(save).toHaveBeenCalledExactlyOnceWith(ID, { bio, games, timezone: "Europe/London" });
      expect(store.rows.get(ID)).toMatchObject({ bio, games });
    });

    for (const alphabet of alphabets) {
      it.each([
        { name: "bio", fields: { bio: alphabet.text(1001), games_text: "Halo", timezone: "" }, error: "Keep your bio to 1000 characters or fewer." },
        { name: "raw games text", fields: { bio: "", games_text: alphabet.text(80) + " ".repeat(1621), timezone: "" }, error: "Games list is too long." },
        { name: "game name", fields: { bio: "", games_text: alphabet.text(81), timezone: "" }, error: "Keep each game name to 80 characters or fewer." },
        { name: "game count", fields: { bio: "", games_text: Array.from({ length: 21 }, (_, i) => String(i) + alphabet.text(1)).join("\n"), timezone: "" }, error: "Add no more than 20 games." },
      ])(`rejects ${alphabet.name} over-limit $name without saving`, async ({ fields, error }) => {
        const { html, submit, save } = await setup();
        expectCodePointForm(await html());
        const response = await submit(path, fields);
        expect(response.status).toBe(422);
        if (path === "native POST") {
          const invalidHtml = await response.text();
          expect(invalidHtml).toContain(error);
          expect(invalidHtml).toContain(fields.bio);
          expect(invalidHtml).toContain(fields.games_text);
          expectCodePointForm(invalidHtml);
        } else {
          expect(await response.json()).toEqual({ errors: { [error.startsWith("Keep your bio") ? "bio" : "games"]: error } });
        }
        expect(save).not.toHaveBeenCalled();
      });
    }

    it("preserves whitespace normalization and ordered deduplication", async () => {
      const { submit, save } = await setup();
      const games = Array.from({ length: 20 }, (_, i) => `${i}🎮`);
      const fields = { bio: "  遊🎮  ", games_text: ["", ...games, ` ${games[0]} `, " "].join("\r\n"), timezone: "" };
      expect(profileClientErrors(fields)).toEqual({});
      expect((await submit(path, fields)).status).toBe(path === "native POST" ? 303 : 200);
      expect(save).toHaveBeenCalledExactlyOnceWith(ID, { bio: "遊🎮", games, timezone: null });
    });

    const noWriteCases: { fields: Fields; trap: Record<string, string>; status: number }[] = [
      { fields: { bio: "bad\u0000bio", games_text: "Halo", timezone: "" }, trap: {}, status: 422 },
      { fields: { bio: "Hello", games_text: "Halo", timezone: "" }, trap: { [PROFILE_HONEY_FIELD]: "spam" }, status: path === "native POST" ? 303 : 200 },
      { fields: { bio: "Hello", games_text: "Halo", timezone: "" }, trap: { [PROFILE_OPENED_AT_FIELD]: String(Date.now() + 60_000) }, status: path === "native POST" ? 303 : 200 },
    ];
    it.each(noWriteCases)("preserves control and honeypot no-write behavior ($status)", async ({ fields, trap, status }) => {
      const { submit, save } = await setup();
      expect((await submit(path, fields, trap)).status).toBe(status);
      expect(save).not.toHaveBeenCalled();
    });
  });
}

// Opt in where Chromium is installed; ordinary route regressions need no browser.
// A11Y_BROWSER_TESTS=true npx vitest run test/profile-native-length.test.ts
// Ephemeral loopback fixtures serve the real SSR/binder and memory stores.
// No live database, staging identity or external service is used.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")("native browser submission and real island binder", () => {
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
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    })));
  });

  async function openProfile(javaScriptEnabled: boolean) {
    const fixture = await setup();
    const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: "block" });
    contexts.push(context);
    const writes: { method: string; status: number; body: string }[] = [];
    const assets: Record<string, { body: string; contentType: string }> = {
      "/styles.css": { body: readFileSync("public/styles.css", "utf8"), contentType: "text/css" },
      "/islands/member-profile.js": { body: readFileSync("public/islands/member-profile.js", "utf8"), contentType: "text/javascript" },
      "/islands/avatar.js": { body: readFileSync("public/islands/avatar.js", "utf8"), contentType: "text/javascript" },
    };
    let base: string;
    const server = createServer(async (request, reply) => {
      try {
        const url = new URL(request.url!, base);
        const asset = assets[url.pathname];
        if (asset) { reply.writeHead(200, { "content-type": asset.contentType }); reply.end(asset.body); return; }
        if (url.pathname !== "/profile" && !url.pathname.startsWith("/members/")) { reply.writeHead(204); reply.end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = Buffer.concat(chunks).toString("utf8");
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        }
        const response = await fixture.app.request(url.href, {
          method: request.method, headers, body: input || undefined,
        }, { ...env, APP_URL: base });
        let body = await response.text();
        // Model time already spent editing, without sleeping or changing the trap.
        if (response.headers.get("content-type")?.includes("text/html")) {
          body = body.replace(new RegExp(`(name="${PROFILE_OPENED_AT_FIELD}" value=")[^"]+`), (_, prefix) => prefix + String(Date.now() - 5000));
        }
        if (request.method !== "GET") writes.push({ method: request.method!, status: response.status, body: input });
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
    // A genuine synthetic cookie survives native redirects; extra Cookie headers do not.
    const separator = fixture.cookie.indexOf("=");
    await context.addCookies([{ name: fixture.cookie.slice(0, separator), value: fixture.cookie.slice(separator + 1), url: base.replace("http:", "https:") + "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    // Contain all page traffic to its ephemeral fixture, including redirects.
    await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${base}/profile`);
    return { ...fixture, page, writes, base };
  }

  async function enter(page: Page, name: string, value: string) {
    await page.locator(`[name="${name}"]`).focus();
    // Real user-edit input respects native maxlength, unlike assigning .value.
    await page.keyboard.insertText(value);
    expect(await page.locator(`[name="${name}"]`).inputValue()).toBe(value);
  }

  for (const javaScriptEnabled of [false, true]) {
    describe(javaScriptEnabled ? "JS island" : "no-JS form", () => {
      it.each(alphabets)("saves intact $name boundaries after real user input", async ({ text, units }) => {
        const { page, writes, save, base } = await openProfile(javaScriptEnabled);
        const bio = text(1000);
        const games = Array.from({ length: 20 }, (_, i) => String(i) + text(80 - String(i).length));
        const list = games.join("\n");
        const serializedList = javaScriptEnabled ? list : list.replaceAll("\n", "\r\n");
        const games_text = list + " ".repeat(1700 - [...serializedList].length);
        expect([...(javaScriptEnabled ? games_text : games_text.replaceAll("\n", "\r\n"))]).toHaveLength(1700);
        expect(bio.length).toBe(units);
        await enter(page, "bio", bio);
        await enter(page, "games_text", games_text);
        await page.getByTestId("profile-save").click();
        if (javaScriptEnabled) await page.getByTestId("profile-saved").waitFor();
        else await page.waitForURL(`${base}/members/${ID}`);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ method: javaScriptEnabled ? "PATCH" : "POST", status: javaScriptEnabled ? 200 : 303 });
        if (javaScriptEnabled) expect(JSON.parse(writes[0]!.body)).toMatchObject({ bio, games_text });
        else {
          const posted = new URLSearchParams(writes[0]!.body);
          expect(posted.get("_method")).toBe("PATCH");
          expect(posted.get("bio")).toBe(bio);
          // Native form serialization normalizes textarea LF to CRLF.
          expect(posted.get("games_text")).toBe(games_text.replaceAll("\n", "\r\n"));
        }
        expect(save).toHaveBeenCalledExactlyOnceWith(ID, { bio, games, timezone: null });
      });

      it.each([
        { name: "bio", bio: "🎮".repeat(1001), games: "Halo", error: "Keep your bio to 1000 characters or fewer.", clientRejects: true },
        { name: "raw list", bio: "", games: "🎮".repeat(80) + " ".repeat(1621), error: "Games list is too long.", clientRejects: false },
        { name: "game name", bio: "", games: "遊🎮".repeat(40) + "遊", error: "Keep each game name to 80 characters or fewer.", clientRejects: true },
        { name: "game count", bio: "", games: Array.from({ length: 21 }, (_, i) => `${i}🎮`).join("\n"), error: "Add no more than 20 games.", clientRejects: true },
      ])("reports over-limit $name and retains input without saving", async ({ bio, games, error, clientRejects }) => {
        const { page, writes, save } = await openProfile(javaScriptEnabled);
        await enter(page, "bio", bio);
        await enter(page, "games_text", games);
        await page.getByTestId("profile-save").click();
        await page.getByTestId("profile-error").waitFor();
        expect(await page.getByTestId("profile-error").textContent()).toContain(error);
        expect(await page.locator('[name="bio"]').inputValue()).toBe(bio);
        expect(await page.locator('[name="games_text"]').inputValue()).toBe(games);
        if (javaScriptEnabled && clientRejects) expect(writes).toEqual([]);
        else {
          expect(writes).toHaveLength(1);
          expect(writes[0]).toMatchObject({ method: javaScriptEnabled ? "PATCH" : "POST", status: 422 });
        }
        expect(save).not.toHaveBeenCalled();
      });
    });
  }
});
