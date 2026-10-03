// route-inventory: GET /auth/discord/callback
// route-inventory: GET /join/callback
// TOG-12617: pin OAuth exchange outcome copy — expired grant vs outage vs replay.
//
// Ports no new product behaviour. Mounted-app suite (local fixtures, no live
// Discord) pinning the three user-visible exchange outcomes end to end on both
// the ordinary login journey (`/auth/discord/callback`) and the one-click join
// journey (`/join/callback`):
//   1. expired/spent grant (400 + invalid_grant) -> expired copy with a
//      fresh-start CTA, never the outage copy;
//   2. provider outage/timeout (5xx with an invalid_grant body, or a transport
//      throw) -> outage copy, never the expired copy (status governs);
//   3. replayed code/state after a successful exchange -> refused before a
//      second exchange with no duplicate success side effects.
//
// Scope guard: drives the mounted app only. No src edits; no imports from the
// hot modules beyond the memory session store test seam.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { createMemorySessionStore, type Sql } from "../src/sessions";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "508654771276873729",
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the join journey. Mirrors test/join.test.ts: the
// throttle bucket never fills, attempts record the four safe columns.
function fakeSql() {
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      const [outcome, source, requestId, discordId] = values as [
        string,
        string | null,
        string | null,
        string | null,
      ];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql: withThrottleTx(sql), attempts };
}

function isolated() {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const create = vi.spyOn(store, "create");
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as Env;
  return { store, fake, create, env: e };
}

// 400 + invalid_grant: the approval was spent, replayed or timed out.
const expiredGrant = () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

// 503 + invalid_grant body: status governs — still an outage, never expired.
const outageGrant = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 503 });

function stubTokenExchange(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      calls.push(new URL(url).pathname);
      if (url.endsWith("/oauth2/token")) return answer();
      throw new Error(`no Discord request allowed after a rejected exchange: ${url}`);
    }),
  );
  return calls;
}

// Full success stub: token -> user -> PUT member -> GET roles.
function stubSuccess() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      calls.push(new URL(url).pathname);
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "fixture-access" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

async function startLogin(e: Env) {
  const res = await app.request("/auth/discord", {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res) };
}

async function startJoin(e: Env) {
  const res = await app.request("/join/discord", {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("expired grant pins expired copy, never outage copy", () => {
  it("login: 400 invalid_grant redirects to the generic banner with a fresh sign-in CTA", async () => {
    const { create, env: e } = isolated();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = stubTokenExchange(expiredGrant);
    const { state, cookie } = await startLogin(e);
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      {
        headers: { cookie },
      },
      e,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toEqual(["/api/v10/oauth2/token"]);
    expect(create).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");

    const home = await app.request("/?n=signin_failed", {}, e);
    const html = await home.text();
    expect(html).toContain("didn");
    expect(html).toContain("Please try again");
    expect(html).not.toContain("did not answer just now");
    expect(html).not.toContain("on Discord, not you");
    expect(html).toContain('href="/auth/discord"');
    expect(JSON.stringify(warn.mock.calls)).toContain("expired_grant");
  });

  it("join: 400 invalid_grant renders the expired approval page with retry + invite, never outage copy", async () => {
    const { fake, create, env: e } = isolated();
    const calls = stubTokenExchange(expiredGrant);
    const { state, cookie } = await startJoin(e);
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      {
        headers: { cookie },
      },
      e,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join approval expired");
    expect(html).toContain("That Discord approval expired");
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain("https://discord.gg/invite");
    expect(html).not.toContain("Discord is unreachable");
    expect(html).not.toContain("Join link expired");
    expect(calls).toEqual(["/api/v10/oauth2/token"]);
    expect(create).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(fake.attempts).toEqual([
      { outcome: "error", source: null, requestId: null, discordId: null },
    ]);
  });
});

describe("provider outage pins outage copy, never expired copy", () => {
  it.each([
    ["5xx whose body says invalid_grant", outageGrant],
    ["transport throw (timeout)", () => Promise.reject(new TypeError("fetch failed"))],
  ])("login outage %s redirects to the unavailable banner", async (_name, answer) => {
    const { create, env: e } = isolated();
    const calls = stubTokenExchange(answer as () => Response | Promise<Response>);
    const { state, cookie } = await startLogin(e);
    const res = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      {
        headers: { cookie },
      },
      e,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_unavailable");
    expect(calls).toEqual(["/api/v10/oauth2/token"]);
    expect(create).not.toHaveBeenCalled();

    const home = await app.request("/?n=signin_unavailable", {}, e);
    const html = await home.text();
    expect(html).toContain("did not answer just now");
    expect(html).toContain("on Discord, not you");
    expect(html).toContain("try again in a minute");
    expect(html).toContain('href="/auth/discord"');
  });

  it.each([
    ["5xx whose body says invalid_grant", outageGrant],
    ["transport throw (timeout)", () => Promise.reject(new TypeError("fetch failed"))],
  ])("join outage %s renders the unreachable page, never expired copy", async (_name, answer) => {
    const { fake, create, env: e } = isolated();
    const calls = stubTokenExchange(answer as () => Response | Promise<Response>);
    const { state, cookie } = await startJoin(e);
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      {
        headers: { cookie },
      },
      e,
    );
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain("https://discord.gg/invite");
    expect(html).not.toContain("Join approval expired");
    expect(html).not.toContain("That Discord approval expired");
    expect(html).not.toContain("Join link expired");
    expect(calls).toEqual(["/api/v10/oauth2/token"]);
    expect(create).not.toHaveBeenCalled();
    expect(fake.attempts).toEqual([
      { outcome: "error", source: null, requestId: null, discordId: null },
    ]);
  });
});

describe("replayed code/state refused before a second exchange", () => {
  it("login: replaying the consumed state issues no second session and never re-exchanges", async () => {
    const { create, env: e } = isolated();
    const calls = stubSuccess();
    const { state, cookie } = await startLogin(e);
    const first = await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      {
        headers: { cookie },
      },
      e,
    );
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toMatch(/\/\?n=(joined|already_member|join_failed)/);
    expect(create).toHaveBeenCalledTimes(1);
    const exchanges = calls.length;

    // The browser honoured the state-cookie deletion, so the replay arrives
    // without state: refused as generic failure before any second exchange.
    const replay = await app.request(`/auth/discord/callback?code=abc&state=${state}`, {}, e);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/?n=signin_failed");
    expect(replay.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(calls).toHaveLength(exchanges);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("join: replaying the consumed state creates no duplicate session or success attempt", async () => {
    const { fake, create, env: e } = isolated();
    const calls = stubSuccess();
    const { state, cookie } = await startJoin(e);
    const first = await app.request(
      `/join/callback?code=abc&state=${state}`,
      {
        headers: { cookie },
      },
      e,
    );
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/?n=joined");
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    const exchanges = calls.length;
    expect(exchanges).toBeGreaterThan(1);

    // Same consumed state without the single-use cookie: the expired-link page,
    // never a second exchange and never a second session.
    const replay = await app.request(`/join/callback?code=abc&state=${state}`, {}, e);
    expect(replay.status).toBe(200);
    const html = await replay.text();
    expect(html).toContain("Join link expired");
    expect(html).toContain("That join link expired");
    expect(html).not.toContain("Join approval expired");
    expect(html).not.toContain("Discord is unreachable");
    expect(calls).toHaveLength(exchanges);
    expect(create).toHaveBeenCalledTimes(1);
    // The replay is logged as an error row, not a duplicate success: still
    // exactly one added/already_member row and no new session.
    expect(
      fake.attempts.filter((a) => a.outcome === "added" || a.outcome === "already_member"),
    ).toHaveLength(1);
  });
});
