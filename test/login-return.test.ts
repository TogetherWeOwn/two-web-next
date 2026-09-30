// TOG-10356: the ordinary-login return journey and the join-result
// confirmation. Ports two-web ReturnToPageTest (login_next / url.intended /
// join_next precedence, hostile values never leaving the app) and
// AlreadyMemberReinviteTest (join_result flash → data-testid="join-result"
// banner + reinvite link) onto the signed-cookie journey in
// src/return-journey.ts. No production or staging login is touched; every
// Discord call is mocked.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import {
  JOIN_RESULT_COOKIE,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
} from "../src/return-journey";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore, type Sql } from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// In-memory Sql double for the join journey's throttle/attempt statements —
// same shape as test/join.test.ts.
function fakeSql() {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return sql;
}

function isolated(extra: Record<string, unknown> = {}) {
  const store = createMemorySessionStore();
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fakeSql() },
    ...extra,
  } as unknown as Env;
  return { store, env };
}

/** Discord stub identical to join.test.ts: exchange, identity, guild join, roles. */
function mockDiscord({ joinStatus = 201, memberRoles = [], token = "user-token", userId = "42" } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: token });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: userId, username: "rick", global_name: "Rick", avatar: null });
      if (url.includes(`/members/${userId}`) && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes(`/members/${userId}`))
        return Response.json({ roles: memberRoles, joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

// Minimal cookie jar: later Set-Cookie wins, Max-Age=0 deletes — mirrors what a
// real browser sends back, including rotated session values.
type Jar = Record<string, string>;
const jarFrom = (res: Response, into: Jar = {}): Jar => {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    if (value === "" || attrs.some((a) => /max-age=0/i.test(a.trim()))) delete into[name];
    else into[name] = value;
  }
  return into;
};
const sendJar = (j: Jar) => Object.entries(j).map(([k, v]) => `${k}=${v}`).join("; ");
const setCookies = (res: Response) => res.headers.getSetCookie().join("\n");

async function sessionCookie(store: SessionStore, row: { userId: string; member: boolean; moderator?: boolean }) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.userId,
    avatar: null,
    member: row.member,
    moderator: row.moderator ?? false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
}

const startLogin = async (e: Env, query = "", cookie = "") => {
  const res = await app.request(`/auth/discord${query}`, { headers: cookie ? { cookie } : {} }, e);
  const location = res.headers.get("location");
  return { res, state: location ? new URL(location).searchParams.get("state") : null, jar: jarFrom(res) };
};
const finishLogin = (e: Env, state: string | null, j: Jar, extra = "code=abc") =>
  app.request(`/auth/discord/callback?${extra}${state ? `&state=${state}` : ""}`, { headers: { cookie: sendJar(j) } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("login_next (legacy ReturnToPageTest)", () => {
  it("carries a safe ?next= through OAuth and lands there exactly once", async () => {
    mockDiscord();
    const { env } = isolated();
    const start = await startLogin(env, "?next=%2Fe%2Fsunday-squad-01");
    expect(setCookies(start.res)).toContain(`${LOGIN_NEXT_COOKIE}=`);
    const cb = await finishLogin(env, start.state, start.jar);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/e/sunday-squad-01");
    const cleared = setCookies(cb);
    expect(cleared).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
    expect(cleared).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
  });

  it.each([
    ["absolute URL", "https%3A%2F%2Fevil.test"],
    ["protocol-relative", "%2F%2Fevil.test%2Fx"],
    ["backslash", "%5C%5Cevil.test"],
    ["scheme", "javascript%3Aalert(1)"],
    ["whitespace", "%20%20"],
    ["empty", ""],
  ])("a hostile %s next leaves no trace and lands on the default notice", async (_label, next) => {
    mockDiscord();
    const { env } = isolated();
    const start = await startLogin(env, `?next=${next}`);
    expect(setCookies(start.res)).not.toContain(`${LOGIN_NEXT_COOKIE}=`);
    const cb = await finishLogin(env, start.state, start.jar);
    expect(cb.headers.get("location")).toBe("/?n=joined");
  });

  it("never redirects off-app even with a signed hostile next", async () => {
    mockDiscord();
    const { env } = isolated();
    const start = await startLogin(env);
    // Forged value, valid signature: safeNext still rejects at consume time.
    const forged = (await serializeSigned(LOGIN_NEXT_COOKIE, "https://evil.test", SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
    const cb = await app.request(`/auth/discord/callback?code=abc&state=${start.state}`, {
      headers: { cookie: `${sendJar(start.jar)}; ${forged}` },
    }, env);
    expect(cb.headers.get("location")).toBe("/?n=joined");
  });

  it("ignores an unsigned login_next cookie entirely", async () => {
    mockDiscord();
    const { env } = isolated();
    const start = await startLogin(env);
    const cb = await app.request(`/auth/discord/callback?code=abc&state=${start.state}`, {
      headers: { cookie: `${sendJar(start.jar)}; ${LOGIN_NEXT_COOKIE}=%2Fprofile` },
    }, env);
    expect(cb.headers.get("location")).toBe("/?n=joined");
  });

  it("clears the journey on denial too — nothing survives a cancelled consent", async () => {
    const { env } = isolated();
    const start = await startLogin(env, "?next=%2Fe%2Fx");
    const cb = await finishLogin(env, start.state, start.jar, "error=access_denied");
    expect(cb.headers.get("location")).toBe("/?n=signin_failed");
    const cleared = setCookies(cb);
    expect(cleared).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
    expect(cleared).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
  });
});

describe("url.intended (auth-gate bounce)", () => {
  it.each([
    ["/profile", "/profile"],
    ["/members/123456789012345678", "/members/123456789012345678"],
    ["/admin/", "/admin/"],
    ["/members/123456789012345678?from=card", "/members/123456789012345678?from=card"],
  ])("guest GET %s bounces to OAuth and returns there after sign-in", async (path, landing) => {
    mockDiscord();
    const { env } = isolated();
    const bounce = await app.request(path, {}, env);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord");
    const j = jarFrom(bounce);
    expect(j[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const start = await startLogin(env, "", sendJar(j));
    const cb = await finishLogin(env, start.state, { ...j, ...start.jar });
    expect(cb.headers.get("location")).toBe(landing);
  });

  it("an explicit next beats the recorded intended page, which is still cleared", async () => {
    mockDiscord();
    const { env } = isolated();
    const bounce = await app.request("/profile", {}, env);
    const j = jarFrom(bounce);
    const start = await startLogin(env, "?next=%2Fe%2Ftwo", sendJar(j));
    const cb = await finishLogin(env, start.state, { ...j, ...start.jar });
    expect(cb.headers.get("location")).toBe("/e/two");
    expect(setCookies(cb)).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
  });

  it("a POST bounce does not record an intended page", async () => {
    const { env } = isolated();
    const bounce = await app.request("/admin/", { method: "POST" }, env);
    expect(bounce.status).toBe(302);
    expect(setCookies(bounce)).not.toContain(`${LOGIN_INTENDED_COOKIE}=`);
  });
});

describe("join_result flash (legacy AlreadyMemberReinviteTest)", () => {
  const runJoin = async (env: Env, joinStatus: 201 | 204, next = "") => {
    mockDiscord({ joinStatus });
    const start = await app.request(`/join/discord${next}`, {}, env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const j = jarFrom(start);
    const cb = await app.request(`/join/callback?code=abc&state=${state}`, { headers: { cookie: sendJar(j) } }, env);
    return { cb, jar: jarFrom(cb, j) };
  };

  it("added: the homepage renders the confirmation once, then never again", async () => {
    const { env } = isolated();
    const { cb, jar } = await runJoin(env, 201);
    expect(cb.headers.get("location")).toBe("/?n=joined");
    expect(jar[JOIN_RESULT_COOKIE]).toBeTruthy();

    const first = await app.request("/", { headers: { cookie: sendJar(jar) } }, env);
    const html = await first.text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain("You are in. Finish Discord&#39;s rules screening before you can post.");
    expect(html).not.toContain('data-testid="notice"');
    const after = jarFrom(first, jar);
    expect(after[JOIN_RESULT_COOKIE]).toBeUndefined();

    const second = await app.request("/", { headers: { cookie: sendJar(after) } }, env);
    expect(await second.text()).not.toContain('data-testid="join-result"');
  });

  it("already_member: the banner carries the real reinvite action, not Open Discord", async () => {
    const { env } = isolated();
    const { jar } = await runJoin(env, 204);
    const first = await app.request("/", { headers: { cookie: sendJar(jar) } }, env);
    const html = await first.text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain("You are already in the server.");
    expect(html).toContain('href="/discord" data-testid="reinvite-link"');
    expect(html).toContain("Rejoin with the Discord invite");
  });

  it("/join renders the banner and drops its public cache for that view", async () => {
    const { env } = isolated();
    const { jar } = await runJoin(env, 204);
    const page = await app.request("/join", { headers: { cookie: sendJar(jar) } }, env);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    const html = await page.text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain('data-testid="reinvite-link"');
    const plain = await app.request("/join", {}, env);
    expect(plain.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await plain.text()).not.toContain('data-testid="join-result"');
  });

  it("a forged join_result value renders nothing", async () => {
    const { env } = isolated();
    const forged = `${JOIN_RESULT_COOKIE}=already_member`;
    const res = await app.request("/", { headers: { cookie: forged } }, env);
    expect(await res.text()).not.toContain('data-testid="join-result"');
  });
});

describe("/join next forwarding (legacy ReturnToPageTest)", () => {
  it("a safe next survives onto the one-click link; a hostile one leaves no trace", async () => {
    const { env } = isolated();
    const safe = await app.request("/join?next=%2Fe%2Fsunday-squad-01", {}, env);
    const safeHtml = await safe.text();
    expect(safeHtml).toContain('data-testid="join-oneclick"');
    expect(safeHtml).toContain("/join/discord?next=%2Fe%2Fsunday-squad-01");

    const hostile = await app.request("/join?next=https%3A%2F%2Fevil.test", {}, env);
    const hostileHtml = await hostile.text();
    expect(hostileHtml).not.toContain("evil.test");
    expect(hostileHtml).toContain('href="/join/discord"');
  });
});

// Rendered-state checks that need real rows behind the page. CI runs these
// against the postgres service; locally they run against agent-testdb when
// DATABASE_URL points at a migrated database. Never production or staging.
describe.skipIf(!process.env.DATABASE_URL)("event CTAs + profile banner (agent-testdb)", async () => {
  const { createDb } = await import("../src/db/index");
  const { events, rsvps, activityLog } = await import("../src/db/admin-schema");
  const { users, profiles } = await import("../src/db/schema");
  const db = createDb(process.env.DATABASE_URL!);
  const KEY = "01J0AABBCCDDEEFFGGHHMMNNPP";

  const envFor = (store: SessionStore) =>
    ({ ...baseEnv, SESSION_STORE: store, ADMIN_DB: db, JOIN_DEPS: { store: async () => fakeSql() } }) as unknown as Env;

  beforeEach(async () => {
    await db.delete(rsvps);
    await db.delete(activityLog);
    await db.delete(events);
    await db.delete(profiles);
    await db.delete(users);
    await db.insert(events).values({
      eventKey: KEY,
      title: "Sunday Squad",
      status: "published",
      startsAt: new Date("2099-11-04T20:00:00Z"),
      endsAt: new Date("2099-11-04T22:00:00Z"),
    });
  });

  it("event page shows guests the join pitch carrying this page as next", async () => {
    const { env } = { env: envFor(createMemorySessionStore()) };
    const res = await app.request(`/e/${KEY}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await res.text();
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).toContain("Game nights get posted here first. Join the Discord and you&#39;ll see them before they land on this page.");
    expect(html).toContain(`href="/join?next=%2Fe%2F${KEY}" data-testid="discord-join"`);
  });

  it("event page hides the pitch from a member and keeps their response private", async () => {
    const store = createMemorySessionStore();
    const cookie = await sessionCookie(store, { userId: "42", member: true });
    const res = await app.request(`/e/${KEY}`, { headers: { cookie } }, envFor(store));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).not.toContain('data-testid="event-join-pitch"');
    expect(html).not.toContain('data-testid="discord-join"');
  });

  it("a signed-in non-member still gets the join pitch", async () => {
    const store = createMemorySessionStore();
    const cookie = await sessionCookie(store, { userId: "43", member: false });
    const res = await app.request(`/e/${KEY}`, { headers: { cookie } }, envFor(store));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain('data-testid="event-join-pitch"');
  });

  it("/events cards carry the login CTA with the page as next for guests only", async () => {
    const guest = await app.request("/events", {}, envFor(createMemorySessionStore()));
    expect(guest.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await guest.text();
    expect(html).toContain('href="/auth/discord?next=%2Fevents" data-testid="events-login"');
    expect(html).toContain("Log in with Discord");

    const store = createMemorySessionStore();
    const cookie = await sessionCookie(store, { userId: "42", member: true });
    const member = await app.request("/events", { headers: { cookie } }, envFor(store));
    expect(member.headers.get("cache-control")).toBe("private, no-store");
    expect(await member.text()).not.toContain('data-testid="events-login"');
  });

  it("the join_result banner lands on /profile too and is consumed there", async () => {
    // /profile validates the snowflake shape before the store lookup, so the
    // stubbed Discord identity needs a real-shaped id here (elsewhere "42" is fine).
    const snow = "326474832151838721";
    await db.insert(users).values({ id: snow, username: "Rick", member: true });
    const store = createMemorySessionStore();
    const env = envFor(store);
    mockDiscord({ joinStatus: 204, userId: snow });

    const start = await app.request("/join/discord", {}, env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cb = await app.request(`/join/callback?code=abc&state=${state}`, { headers: { cookie: sendJar(jarFrom(start)) } }, env);
    const jar = jarFrom(cb, jarFrom(start));
    expect(jar[JOIN_RESULT_COOKIE]).toBeTruthy();

    const profile = await app.request("/profile", { headers: { cookie: sendJar(jar) } }, env);
    expect(profile.status).toBe(200);
    const html = await profile.text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain('data-testid="reinvite-link"');
  });
});
