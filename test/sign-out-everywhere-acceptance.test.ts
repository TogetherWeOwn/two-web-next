// Acceptance oracle: sign out of every session at once.
//
// Owned acceptance file: the builder consumes it unchanged and never edits it.
// Every RED test below fails on the pre-change head for the reason it names and
// names the exact passing condition. GREEN controls pin behavior that must not
// change and already pass.
//
// Contract under test:
// - Route: POST /logout/everywhere (Hono-owned, like POST /logout).
// - UI: an explicit "Sign out everywhere" form next to the existing profile
//   sign-out on both twins, with
//   `<form method="post" action="/logout/everywhere"
//     data-testid="profile-signout-everywhere">` and a submit button whose
//   visible text is exactly "Sign out everywhere". It renders in the profile
//   header for a signed-in member on /profile and /members/:id (Hono) and in
//   web/src/lib/ProfileView.svelte (Kit), beside the existing
//   data-testid="profile-signout" form. Plain form POST works with no JavaScript.
// - Admission, in order: app-wide same-origin guard, `action` body cap before
//   the throttle (oversized 413 with zero throttle spend), then the 30/min
//   write throttle with the one 429 envelope, then session work. A spent
//   throttle or a cross-origin refusal revokes nothing and clears no cookies.
// - Effect: revokes every live session for the acting member only, including
//   the presented one, through the existing SessionStore.revokeUserSessions
//   path (hash-only: no raw bearer, no member-data echo), clears the
//   __Host-two_session and __Host-two_session_status cookies (Max-Age=0), and
//   answers 303 to "/" so the browser lands signed-out. Other members' sessions
//   stay live. No session identifier (bearer, hash, user id) renders in HTML or
//   diagnostics.
// - Single-session POST /logout is unchanged: it revokes only the presented
//   session (plus its lineage/grace), never a sibling device session.
// - Expired or unknown presented bearers are idempotent success: 303 to "/"
//   with cleared cookies, never 503, and no sibling revoke (the user cannot be
//   resolved from a dead bearer).
// - Store failure is authoritative: a throwing revocation answers 503 without
//   clearing cookies, like POST /logout.
// - Sliding window (120 min) and absolute cap (24 h) are unchanged; no
//   remember-me, no session listing, no per-device names.
//
// RED proof on the pre-change head: every test named RED fails because
// POST /logout/everywhere answers 404 (unknown route) or the twins lack the
// form, so the pinned 303/429/413/503 status, the revocation state, the cookie
// clears, or the markup assertion cannot hold. The two origin tests assert the
// app-wide 403 (which already holds pre-change) plus a valid-origin 303
// control that fails 404 pre-change, so the test as a whole is RED for the
// named missing route. GREEN controls pass pre-change and guard the builder
// against regressions.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { withThrottleTx } from "./helpers/throttle-tx-double";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const SESSION_COOKIE = "__Host-two_session";
const STATUS_COOKIE = "__Host-two_session_status";
const EVERYWHERE_PATH = "/logout/everywhere";
const EVERYWHERE_TESTID = "profile-signout-everywhere";
const EVERYWHERE_COPY = "Sign out everywhere";
const SINGLETON_FORM = '<form method="post" action="/logout" data-testid="profile-signout">';

const ACTOR = {
  userId: "100000000000000211",
  username: "everywhere-actor",
  member: true,
  moderator: false,
} as const;
const OTHER = {
  userId: "100000000000000212",
  username: "everywhere-other",
  member: true,
  moderator: false,
} as const;

type Minted = { token: string; hash: string; cookie: string };

async function mint(
  store: SessionStore,
  actor: typeof ACTOR | typeof OTHER,
  expiresAt: Date = new Date(Date.now() + 3_600_000),
): Promise<Minted> {
  const token = newSessionToken();
  const hash = await hashToken(token);
  await store.create({
    tokenHash: hash,
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt,
  });
  const cookie = (
    await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { token, hash, cookie };
}

// Postgres fixture helper: binds expiry as ISO text because postgres.js date
// serialization varies by version (same workaround as the revoke-sessions
// suite). Memory tests keep using mint() with a Date.
async function mintDb(
  store: SessionStore,
  actor: typeof ACTOR | typeof OTHER,
  expiresAt: Date = new Date(Date.now() + 3_600_000),
): Promise<Minted> {
  const token = newSessionToken();
  const hash = await hashToken(token);
  await store.create({
    tokenHash: hash,
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt: expiresAt.toISOString() as unknown as Date,
  });
  const cookie = (
    await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { token, hash, cookie };
}

function envFor(
  store: SessionStore,
  throttle?: { store: () => Promise<Sql | null> },
): Env & { SESSION_STORE: SessionStore } & Partial<EnvWithThrottle> {
  return {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    SESSION_STORE: store,
    ...(throttle ? { THROTTLE_STORE: throttle.store } : {}),
  } as unknown as Env & { SESSION_STORE: SessionStore } & Partial<EnvWithThrottle>;
}

function throttleFixture(initial: number) {
  let hits = initial;
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const store = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
  return { sql, store, count: () => hits };
}

function cleared(res: Response, name: string): boolean {
  return res.headers
    .getSetCookie()
    .some((line) => line.startsWith(`${name}=`) && /Max-Age=0/i.test(line));
}

function leaked(text: string, secrets: string[]): string[] {
  return secrets.filter((secret) => secret && text.includes(secret));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("fixture must remain offline"))),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sign out everywhere revokes the actor only (memory store)", () => {
  it("RED: POST /logout/everywhere revokes both actor sessions, keeps the other member live, clears cookies, and lands signed-out", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    const other = await mint(store, OTHER);
    const sweep = vi.spyOn(store, "revokeUserSessions");

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "text/html" },
      },
      envFor(store),
    );

    // Passing condition: the new route exists and answers like POST /logout.
    expect(
      res.status,
      "RED fails here on the pre-change head: unknown route answers 404, not 303",
    ).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cleared(res, SESSION_COOKIE), "session cookie must clear with Max-Age=0").toBe(true);
    expect(cleared(res, STATUS_COOKIE), "status cookie must clear with Max-Age=0").toBe(true);
    expect(res.headers.get("cache-control")).toContain("no-store");

    // Both actor sessions die (presented + sibling); the other member stays live.
    expect(await store.get(current.hash), "presented actor session must revoke").toBeNull();
    expect(await store.get(sibling.hash), "sibling actor session must revoke").toBeNull();
    expect(await store.get(other.hash), "other member session must stay live").not.toBeNull();

    // Hash-only revocation scoped to the actor: the user id plus a hash, never
    // a raw bearer. The builder may revoke the presented row first and then
    // sweep, or sweep with a non-matching except-hash; either way the sweep
    // runs for the actor and no call carries a raw token.
    expect(sweep, "must revoke through SessionStore.revokeUserSessions").toHaveBeenCalled();
    expect(sweep.mock.calls[0]?.[0]).toBe(ACTOR.userId);
    for (const call of sweep.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(current.token);
        expect(String(arg)).not.toContain(sibling.token);
        expect(String(arg)).not.toContain(other.token);
      }
    }

    // No session identifier in the response: bearer, hash, or user id.
    const body = await res.text();
    expect(
      leaked(body, [current.token, sibling.token, current.hash, sibling.hash, ACTOR.userId]),
      "response must not echo session identifiers",
    ).toEqual([]);

    // The browser lands signed-out: both old actor cookies replay to guest.
    for (const cookie of [current.cookie, sibling.cookie]) {
      const replay = await app.request("/", { headers: { cookie } }, envFor(store));
      expect(await replay.text()).toContain("Sign in with Discord");
    }
    const otherPage = await app.request("/", { headers: { cookie: other.cookie } }, envFor(store));
    expect(await otherPage.text()).toContain(OTHER.username);
  });

  it("GREEN control: single-session POST /logout still revokes only the presented session", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    const other = await mint(store, OTHER);

    const res = await app.request(
      "/logout",
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "text/html" },
      },
      envFor(store),
    );

    // Already true pre-change; the builder must keep it true.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(await store.get(current.hash)).toBeNull();
    expect(
      await store.get(sibling.hash),
      "sibling device session must survive single logout",
    ).not.toBeNull();
    expect(await store.get(other.hash)).not.toBeNull();
  });

  it("RED: no-JS form POST (urlencoded body, HTML accept) revokes every actor session", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    const other = await mint(store, OTHER);

    const res = await app.request(
      new Request(new URL(EVERYWHERE_PATH, APP_URL), {
        method: "POST",
        body: new URLSearchParams({ confirm: "1" }).toString(),
        headers: {
          origin: APP_URL,
          cookie: current.cookie,
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
      undefined,
      envFor(store),
    );

    expect(
      res.status,
      "RED fails here on the pre-change head: form POST answers 404, not 303",
    ).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cleared(res, SESSION_COOKIE)).toBe(true);
    expect(cleared(res, STATUS_COOKIE)).toBe(true);
    expect(await store.get(current.hash)).toBeNull();
    expect(await store.get(sibling.hash)).toBeNull();
    expect(await store.get(other.hash)).not.toBeNull();
  });

  it("RED: expired presented bearer is idempotent success (303 + clears, never 503, sibling untouched)", async () => {
    const store = createMemorySessionStore();
    const expired = await mint(store, ACTOR, new Date(Date.now() - 60_000));
    const sibling = await mint(store, ACTOR);
    const other = await mint(store, OTHER);
    expect(await store.get(expired.hash), "fixture must present a dead bearer").toBeNull();

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: expired.cookie, accept: "text/html" },
      },
      envFor(store),
    );

    // Passing condition: dead bearers clear and land signed-out without error.
    // The user cannot be resolved from a dead bearer, so the live sibling stays.
    expect(
      res.status,
      "RED fails here on the pre-change head: expired POST answers 404, not 303",
    ).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cleared(res, SESSION_COOKIE)).toBe(true);
    expect(cleared(res, STATUS_COOKIE)).toBe(true);
    expect(
      await store.get(sibling.hash),
      "live sibling must survive a dead-bearer call",
    ).not.toBeNull();
    expect(await store.get(other.hash)).not.toBeNull();
  });

  it("RED: store failure is authoritative (503, no cookie clear, sessions intact)", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    vi.spyOn(store, "revokeUserSessions").mockRejectedValue(new Error("store down"));
    vi.spyOn(store, "revoke").mockRejectedValue(new Error("store down"));

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "application/json" },
      },
      envFor(store),
    );

    // Passing condition: like POST /logout, a failed revocation fails closed.
    expect(
      res.status,
      "RED fails here on the pre-change head: failing revoke answers 404, not 503",
    ).toBe(503);
    expect(res.headers.getSetCookie(), "failing revocation must not clear cookies").toEqual([]);
    expect(res.headers.get("location")).toBeNull();
    expect(
      await store.get(current.hash),
      "failed revoke must leave the presented session",
    ).not.toBeNull();
    expect(
      await store.get(sibling.hash),
      "failed revoke must leave the sibling session",
    ).not.toBeNull();
    const text = await res.text();
    expect(leaked(text, [current.token, current.hash, ACTOR.userId])).toEqual([]);
  });
});

describe("sign out everywhere admission matches POST /logout", () => {
  it("RED: route exists and cross-origin POST is 403 cross_origin with no revocation and no cookie clear", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    const sweep = vi.spyOn(store, "revokeUserSessions");
    const revoke = vi.spyOn(store, "revoke");

    // The app-wide same-origin guard already 403s unknown routes, so the 403
    // half passes pre-change on its own. The valid-origin control below is the
    // RED half: it proves the route exists and revokes, failing 404 pre-change.
    const refused = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          cookie: current.cookie,
          accept: "application/json",
        },
      },
      envFor(store),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "cross_origin" });
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(sweep).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(await store.get(current.hash)).not.toBeNull();
    expect(await store.get(sibling.hash)).not.toBeNull();

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "application/json" },
      },
      envFor(store),
    );
    expect(
      res.status,
      "RED fails here on the pre-change head: valid-origin control answers 404, not 303",
    ).toBe(303);
    expect(await store.get(current.hash)).toBeNull();
    expect(await store.get(sibling.hash)).toBeNull();
  });

  it("RED: route exists and missing origin without a same-origin fetch hint is 403 with no revocation", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    const sweep = vi.spyOn(store, "revokeUserSessions");

    const refused = await app.request(
      EVERYWHERE_PATH,
      { method: "POST", headers: { cookie: current.cookie, accept: "application/json" } },
      envFor(store),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "cross_origin" });
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(sweep).not.toHaveBeenCalled();
    expect(await store.get(current.hash)).not.toBeNull();

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "application/json" },
      },
      envFor(store),
    );
    expect(
      res.status,
      "RED fails here on the pre-change head: valid-origin control answers 404, not 303",
    ).toBe(303);
    expect(await store.get(current.hash)).toBeNull();
    expect(await store.get(sibling.hash)).toBeNull();
  });

  it("RED: spent throttle budget is the one 429 shape with no revocation and no new hit", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sibling = await mint(store, ACTOR);
    const sweep = vi.spyOn(store, "revokeUserSessions");
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "application/json" },
      },
      envFor(store, throttle),
    );

    expect(
      res.status,
      "RED fails here on the pre-change head: throttled answers 404, not 429",
    ).toBe(429);
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
    expect(throttle.count(), "a refusal must not spend budget").toBe(WRITE_THROTTLE_PER_MINUTE);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sweep).not.toHaveBeenCalled();
    expect(await store.get(current.hash)).not.toBeNull();
    expect(await store.get(sibling.hash)).not.toBeNull();
  });

  it("RED: oversized body is 413 before the throttle with zero spend and zero session work", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sweep = vi.spyOn(store, "revokeUserSessions");
    const get = vi.spyOn(store, "get");
    const throttle = throttleFixture(0);
    const max = BODY_LIMIT_BYTES.action;

    const res = await app.request(
      new Request(new URL(EVERYWHERE_PATH, APP_URL), {
        method: "POST",
        body: "x".repeat(max + 1),
        headers: {
          origin: APP_URL,
          cookie: current.cookie,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(max + 1),
        },
      }),
      undefined,
      envFor(store, throttle),
    );

    expect(
      res.status,
      "RED fails here on the pre-change head: oversized answers 404, not 413",
    ).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "payload_too_large" });
    expect(throttle.store, "the cap decides before the throttle store").not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expect(sweep).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(await store.get(current.hash)).not.toBeNull();
  });

  it("GREEN control: GET on the everywhere path never revokes (method-owned, like GET /logout)", async () => {
    const store = createMemorySessionStore();
    const current = await mint(store, ACTOR);
    const sweep = vi.spyOn(store, "revokeUserSessions");

    const res = await app.request(
      EVERYWHERE_PATH,
      { headers: { cookie: current.cookie } },
      envFor(store),
    );

    // Pre-change this is the frozen 404; post-change it must stay a non-mutating
    // refusal (404 or 405), never a revocation. Either status passes.
    expect([404, 405]).toContain(res.status);
    expect(sweep).not.toHaveBeenCalled();
    expect(await store.get(current.hash)).not.toBeNull();
  });
});

describe("sign out everywhere renders on both twins", () => {
  it("RED: Hono profile header renders the everywhere form next to sign-out on /profile and /members/:id", async () => {
    const store = createMemorySessionStore();
    const cookie = (
      await mint(store, {
        userId: ACTOR.userId,
        username: ACTOR.username,
        member: true,
        moderator: false,
      })
    ).cookie;
    const paths = ["/profile", `/members/${ACTOR.userId}`, `/members/${OTHER.userId}`];
    for (const path of paths) {
      const res = await app.request(path, { headers: { cookie } }, envFor(store));
      expect(res.status, `${path} must render for a signed-in member`).toBe(200);
      const html = await res.text();
      expect(html, `${path} keeps the single-session sign-out`).toContain(SINGLETON_FORM);
      expect(
        html,
        `RED fails here on the pre-change head: ${path} lacks the everywhere form; passing condition is a POST ${EVERYWHERE_PATH} form with ${EVERYWHERE_TESTID} beside sign-out`,
      ).toContain(
        `<form method="post" action="${EVERYWHERE_PATH}" data-testid="${EVERYWHERE_TESTID}">`,
      );
      expect(html, `${path} everywhere button copy`).toContain(EVERYWHERE_COPY);
      // Adjacent in the header: the everywhere form sits beside sign-out, not in
      // the edit panel or stats. Order-insensitive, same header block.
      const header = html.slice(0, html.indexOf("</header>"));
      expect(header, `${path} header must hold both forms`).toContain(SINGLETON_FORM);
      expect(header, `${path} header must hold the everywhere form`).toContain(EVERYWHERE_TESTID);
    }
  });

  it("RED: Kit ProfileView renders the same everywhere form beside sign-out", () => {
    const source = readFileSync(
      fileURLToPath(new NodeURL("../web/src/lib/ProfileView.svelte", import.meta.url)),
      "utf8",
    );
    expect(source, "Kit keeps the single-session sign-out").toContain(
      'data-testid="profile-signout"',
    );
    // Passing condition: the Svelte twin carries the identical form contract so
    // no-JS Kit readers get the same action. Static source pin: the SSR suites
    // prove the twin renders, this pins the form exists to render.
    expect(
      source,
      `RED fails here on the pre-change head: ProfileView.svelte lacks action="${EVERYWHERE_PATH}"`,
    ).toContain(`action="${EVERYWHERE_PATH}"`);
    expect(
      source,
      `RED fails here on the pre-change head: ProfileView.svelte lacks ${EVERYWHERE_TESTID}`,
    ).toContain(`data-testid="${EVERYWHERE_TESTID}"`);
    expect(
      source,
      "RED fails here on the pre-change head: ProfileView.svelte lacks the everywhere copy",
    ).toContain(EVERYWHERE_COPY);
    expect(source, "Kit form must POST like the Hono twin").toContain('method="post"');
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("sign out everywhere against disposable Postgres", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(databaseUrl!, { max: 4 });
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.client`delete from web_sessions`;
    await fixture.client`delete from web_session_grace`;
  });

  it("RED: disposable-DB actor with two live sessions revokes both, other member stays live", async () => {
    const store = createPostgresSessionStore(fixture.client as unknown as Sql);
    const current = await mintDb(store, ACTOR);
    const sibling = await mintDb(store, ACTOR);
    const other = await mintDb(store, OTHER);
    expect(
      await store.get(current.hash),
      "fixture must seed a live presented session",
    ).not.toBeNull();
    expect(
      await store.get(sibling.hash),
      "fixture must seed a live sibling session",
    ).not.toBeNull();
    expect(
      await store.get(other.hash),
      "fixture must seed a live other-member session",
    ).not.toBeNull();

    const res = await app.request(
      EVERYWHERE_PATH,
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "text/html" },
      },
      envFor(store),
    );

    // Passing condition mirrors the memory RED: 303, both cookies clear, actor
    // rows dead by the database clock, other-member row live.
    expect(
      res.status,
      "RED fails here on the pre-change head: disposable-DB POST answers 404, not 303",
    ).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cleared(res, SESSION_COOKIE)).toBe(true);
    expect(cleared(res, STATUS_COOKIE)).toBe(true);
    expect(await store.get(current.hash), "presented actor row must revoke").toBeNull();
    expect(await store.get(sibling.hash), "sibling actor row must revoke").toBeNull();
    expect(await store.get(other.hash), "other member row must stay live").not.toBeNull();
    const live = await fixture.client<{ token_hash: string }[]>`select token_hash from web_sessions
      where revoked_at is null and expires_at > clock_timestamp()`;
    expect(live.map((row) => row.token_hash).sort()).toEqual([other.hash].sort());
  });

  it("GREEN control: disposable-DB single logout still revokes only the presented row", async () => {
    const store = createPostgresSessionStore(fixture.client as unknown as Sql);
    const current = await mintDb(store, ACTOR);
    const sibling = await mintDb(store, ACTOR);
    const other = await mintDb(store, OTHER);

    const res = await app.request(
      "/logout",
      {
        method: "POST",
        headers: { origin: APP_URL, cookie: current.cookie, accept: "text/html" },
      },
      envFor(store),
    );

    expect(res.status).toBe(303);
    expect(await store.get(current.hash)).toBeNull();
    expect(await store.get(sibling.hash), "sibling row must survive single logout").not.toBeNull();
    expect(await store.get(other.hash)).not.toBeNull();
  });
});
