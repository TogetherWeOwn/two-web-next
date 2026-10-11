// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// Both OAuth legs mint, read or clear per-visitor cookies (the signed state, the
// session), so no outcome of either may sit in a shared cache. The siblings
// (/join/discord, /auth/recover) already send `no-store, private`; this pins the
// same header on every response of /auth/discord and /auth/discord/callback.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { withThrottleTx } from "./helpers/throttle-tx-double";

const NO_STORE = "no-store, private";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

/** Fresh memory store + env carrying it, per test. */
const isolated = (extra: Record<string, unknown> = {}) =>
  ({ ...baseEnv, SESSION_STORE: createMemorySessionStore(), ...extra }) as unknown as Env;

/** A throttle store whose bucket is already over budget: every call is limited. */
function exhaustedThrottle(): Pick<EnvWithThrottle, "THROTTLE_STORE"> {
  const sql = withThrottleTx((async (strings: TemplateStringsArray) => {
    const head = strings.join("?");
    if (head.includes("SELECT count(*)")) return [{ n: 999, wait: 30 }];
    return [];
  }) as unknown as Sql);
  return { THROTTLE_STORE: async () => sql };
}

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function mockDiscord({ joinStatus = 201, exchange = 200 } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token"))
        return exchange === 200
          ? Response.json({ access_token: "user-token" })
          : new Response("nope", { status: exchange });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

async function start(e: Env, path = "/auth/discord") {
  const res = await app.request(path, {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { res, state, cookie: cookiesFrom(res) };
}

const callback = (e: Env, query: string, cookie = "") =>
  app.request(`/auth/discord/callback${query}`, { headers: { cookie } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("GET /auth/discord is never cacheable", () => {
  it("the 302 that mints the OAuth state and sets its cookie", async () => {
    const { res } = await start(isolated());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://discord.com/oauth2/authorize");
    expect(res.headers.getSetCookie().join(";")).toContain("__Host-two_oauth_state=");
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("the return-journey variant (?next=)", async () => {
    const { res } = await start(isolated(), "/auth/discord?next=%2Fevents");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("the signin_failed redirect when the OAuth journey cannot be issued", async () => {
    const store = createMemorySessionStore();
    store.journeys.issue = async () => false;
    const res = await app.request("/auth/discord", {}, isolated({ SESSION_STORE: store }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("the signin_failed redirect when issuing the OAuth journey throws", async () => {
    // A transient DB failure in issue() must redirect, never throw to a 500:
    // the issue() call sits inside the same guard as sweepExpired().
    const store = createMemorySessionStore();
    store.journeys.issue = async () => {
      throw new Error("db down");
    };
    const res = await app.request("/auth/discord", {}, isolated({ SESSION_STORE: store }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it.each([
    ["browser", {}],
    ["json", { accept: "application/json" }],
  ])("the throttled 429 for a %s caller", async (_name, headers) => {
    const res = await app.request("/auth/discord", { headers }, isolated(exhaustedThrottle()));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });
});

describe("GET /auth/discord/callback is never cacheable", () => {
  it("the sign-in success redirect that issues the session", async () => {
    const e = isolated();
    mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await start(e);
    const res = await callback(e, `?code=abc&state=${state}`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(res.headers.getSetCookie().join(";")).toContain("__Host-two_session=");
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("the already-member and failed auto-join redirects", async () => {
    for (const [joinStatus, location] of [
      [204, "/?n=already_member"],
      [403, "/?n=join_failed"],
    ] as const) {
      const e = isolated();
      mockDiscord({ joinStatus });
      const { state, cookie } = await start(e);
      const res = await callback(e, `?code=abc&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("cache-control"), location).toBe(NO_STORE);
    }
  });

  it("the consent-denied and generic OAuth error redirects", async () => {
    for (const [query, location] of [
      ["?error=access_denied", "/?n=signin_denied"],
      ["?error=server_error&error_description=boom", "/?n=signin_failed"],
    ] as const) {
      const { cookie } = await start(isolated());
      const res = await callback(isolated(), query, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("cache-control"), query).toBe(NO_STORE);
    }
  });

  it("the forged-state, missing-cookie and missing-code redirects", async () => {
    const e = isolated();
    const { state, cookie } = await start(e);
    for (const [query, ck] of [
      ["?code=abc&state=forged", cookie],
      ["?code=abc&state=x", ""],
      [`?state=${state}`, cookie],
    ] as const) {
      const res = await callback(e, query, ck);
      expect(res.headers.get("location"), query).toBe("/?n=signin_failed");
      expect(res.headers.get("cache-control"), query).toBe(NO_STORE);
    }
  });

  it("the token-exchange failure and provider-outage redirects", async () => {
    for (const [exchange, location] of [
      [400, "/?n=signin_failed"],
      [503, "/?n=signin_unavailable"],
    ] as const) {
      const e = isolated();
      mockDiscord({ exchange });
      const { state, cookie } = await start(e);
      const res = await callback(e, `?code=abc&state=${state}`, cookie);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("cache-control"), String(exchange)).toBe(NO_STORE);
    }
  });

  it.each([
    ["browser", {}],
    ["json", { accept: "application/json" }],
  ])("the throttled 429 for a %s caller", async (_name, headers) => {
    const res = await app.request(
      "/auth/discord/callback?code=abc&state=x",
      { headers },
      isolated(exhaustedThrottle()),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });
});
