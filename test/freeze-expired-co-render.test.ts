// route-inventory: GET /about
// Cutover co-render: the flag-gated freeze banner (src/freeze-banner.ts) and the
// one-shot expired-write banner (src/write-recovery.ts) on one document. The gate
// matrix mounts both middlewares on a fixture-only Hono app in mounted order; one
// mounted /about read proves the real document. No session, no database, no
// network: local signed-cookie fixtures only, so no agent-testdb fixture is needed.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { FREEZE_BANNER_TESTID, freezeBanner } from "../src/freeze-banner";
import { EXPIRED_WRITE_COOKIE, expiredWriteBanner } from "../src/write-recovery";

const SECRET = "local-fixture-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const DATES = "12–14 Oct UTC";
const PUBLIC_CACHE = "public, max-age=3600";

const DOCUMENT_BODY = "<html><body><main>Document</main></body></html>";
const FRAGMENT_BODY = "<main>Fragment only</main>";

const offlineEnv = { APP_URL, SESSION_SECRET: SECRET };
const freezeEnv = { ...offlineEnv, FREEZE_BANNER_ENABLED: "true", FREEZE_BANNER_DATES: DATES };

const mountedEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
  FREEZE_BANNER_ENABLED: "true",
  FREEZE_BANNER_DATES: DATES,
};

const signed = async (value: string) =>
  (await serializeSigned(EXPIRED_WRITE_COOKIE, value, SECRET, { path: "/", secure: true })).split(
    ";",
  )[0]!;
const cleared = (res: Response) =>
  res.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${EXPIRED_WRITE_COOKIE}=`) && /Max-Age=0/i.test(c));
const occurrences = (html: string, testid: string) =>
  html.split(`data-testid="${testid}"`).length - 1;

const fixtureApp = () => {
  const fixture = new Hono();
  // Mounted registration order: expired-write outermost, freeze innermost.
  fixture.use("*", expiredWriteBanner);
  fixture.use("*", freezeBanner);
  fixture.get("/page", (c) => {
    c.header("cache-control", PUBLIC_CACHE);
    return c.html(DOCUMENT_BODY);
  });
  fixture.post("/page", (c) => {
    c.header("cache-control", PUBLIC_CACHE);
    return c.html(DOCUMENT_BODY);
  });
  fixture.get("/stale", (c) => {
    c.header("cache-control", PUBLIC_CACHE);
    return c.html(DOCUMENT_BODY, 404);
  });
  fixture.get("/json", (c) => c.json({ ok: true }));
  fixture.get("/auth/login", (c) => {
    c.header("cache-control", PUBLIC_CACHE);
    return c.html(DOCUMENT_BODY);
  });
  fixture.get("/fragment", (c) => {
    c.header("cache-control", PUBLIC_CACHE);
    return c.html(FRAGMENT_BODY);
  });
  return fixture;
};

describe("freeze + expired-write co-render", () => {
  it("renders both banners inside <main> and goes private with Vary: Cookie", async () => {
    const res = await fixtureApp().request(
      "/page",
      { headers: { cookie: await signed("restored|/profile") } },
      freezeEnv,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(occurrences(html, FREEZE_BANNER_TESTID)).toBe(1);
    expect(occurrences(html, "auth-error")).toBe(1);
    expect(html).toContain(DATES);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/auth/recover?next=%2Fprofile"');
    const main = html.indexOf("<main>");
    expect(main).toBeGreaterThan(-1);
    // Expired-write is the outer post-processor, so its banner lands first.
    expect(html.indexOf('data-testid="auth-error"')).toBeGreaterThan(main);
    expect(html.indexOf(`data-testid="${FREEZE_BANNER_TESTID}"`)).toBeGreaterThan(
      html.indexOf('data-testid="auth-error"'),
    );
    expect(cleared(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
  });

  it("the notice is one-shot: the next read keeps only the freeze banner and shared cache", async () => {
    const res = await fixtureApp().request("/page", {}, freezeEnv);
    const html = await res.text();
    expect(occurrences(html, FREEZE_BANNER_TESTID)).toBe(1);
    expect(html).not.toContain("auth-error");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("freeze off without a notice leaves the document byte-identical", async () => {
    const res = await fixtureApp().request("/page", {}, offlineEnv);
    expect(await res.text()).toBe(DOCUMENT_BODY);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("expired-write gates keep the notice pending: POST, non-200, non-HTML, auth page, fragment", async () => {
    const cookie = await signed("restored|/profile");
    const fixture = fixtureApp();
    const cases: Array<[string, Response, string]> = [
      [
        "POST",
        await fixture.request("/page", { method: "POST", headers: { cookie } }, freezeEnv),
        DOCUMENT_BODY,
      ],
      [
        "non-200",
        await fixture.request("/stale", { headers: { cookie } }, freezeEnv),
        DOCUMENT_BODY,
      ],
      [
        "non-HTML",
        await fixture.request("/json", { headers: { cookie } }, freezeEnv),
        '{"ok":true}',
      ],
      [
        "auth page",
        await fixture.request("/auth/login", { headers: { cookie } }, freezeEnv),
        DOCUMENT_BODY,
      ],
      [
        "fragment",
        await fixture.request("/fragment", { headers: { cookie } }, freezeEnv),
        FRAGMENT_BODY,
      ],
    ];
    for (const [name, res, body] of cases) {
      expect(await res.text(), name).toBe(body);
      expect(res.headers.getSetCookie(), name).toEqual([]);
    }
  });

  it("mounted /about co-renders both banners inside <main> when freeze is on", async () => {
    const res = await app.request(
      "/about",
      { headers: { cookie: await signed("restored|/profile") } },
      mountedEnv,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(occurrences(html, FREEZE_BANNER_TESTID)).toBe(1);
    expect(occurrences(html, "auth-error")).toBe(1);
    const main = html.indexOf("<main");
    expect(main).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="auth-error"')).toBeGreaterThan(main);
    expect(html.indexOf(`data-testid="${FREEZE_BANNER_TESTID}"`)).toBeGreaterThan(main);
    expect(cleared(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
  });
});
