// route-inventory: PATCH /members/:user
// route-inventory: POST /members/:user
// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key
// route-inventory: POST /admin/events/:key/publish
// route-inventory: POST /admin/events/:key/cancel
// route-inventory: POST /admin/events/:key/rsvp-pause
// route-inventory: POST /admin/events/:key/rsvp-reopen
// route-inventory: POST /admin/featured
// route-inventory: POST /admin/featured/:id
// route-inventory: POST /admin/featured/:id/delete
// route-inventory: POST /logout
// route-inventory: POST /csp-reports
// route-inventory: POST /api/agent-events
// route-inventory: POST /__probe/alert
// route-inventory: POST /auth/qa/:identity
// Expired-write recovery audit for the remaining non-RSVP write surfaces.
//
// Full POST/PATCH/PUT/DELETE inventory (25 routes, from test/fixtures/route-inventory.json):
// - Already integrated, not re-proven here:
//   PATCH /events/:key, POST /events, POST /events/:key/{publish,cancel,rsvp-pause,rsvp-reopen}
//   → shared gate via expiredWriteBounce(c, true), proven in test/event-edit-expired-recovery.test.ts.
// - Out of scope (RSVP, covered elsewhere):
//   PUT /events/:key/rsvp, DELETE /events/:key/rsvp, POST /e/:key/rsvp → member-decoy, no recovery.
// - Proven below (bounce through the shared gate, no write, no echo, retry succeeds):
//   PATCH /members/:user, POST /members/:user (member-owner, via profiles gate → bounceToLogin →
//   expiredWriteBounce); POST /admin/* (9 routes, via admin guard → bounceToLogin → expiredWriteBounce).
// - Listed with a reason (no user-session write, so no recovery gate):
//   POST /logout (terminal idempotent revocation: dead bearer still 303 + clears cookies, never a
//   recovery bounce); POST /csp-reports (public session-free sink, always 204); POST /api/agent-events
//   (machine-bearer, dead session cookie is ignored); POST /__probe/alert (staging-token, dead session
//   cookie is ignored); POST /auth/qa/:identity (session-issuing, not session-gated).
//
// Contract on every bounce: JSON callers keep 401 { error, recovery } with a recovery link, native
// form callers keep 303 to /auth/recover?next=<safe GET> (never the write URL); the recovery landing
// and banner carry only a revalidated safe GET destination, never submitted input or a retry.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import production from "../src/index";
import { adminApp } from "../src/admin/routes";
import { sameOrigin } from "../src/same-origin";
import type { Env } from "../src/env";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { fixtureDiscord, MEMBER, mergeCookies, recoveryFixture } from "./fixtures/session-recovery";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { events } from "../src/db/admin-schema";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const MOD_ROLE = "100000000000000010";
const DRAFT_INPUT = "Unsaved secret draft";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
  SESSION_SECRET,
};

async function bearer(
  store: SessionStore,
  row: { userId: string; username: string; member?: boolean; moderator?: boolean },
  expiresAt = new Date(Date.now() + 3600_000),
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member ?? true,
    moderator: row.moderator ?? false,
    expiresAt,
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

/** Any store touch throws: a bounce proves the guard ran before the handler. */
const untouchedDb = () =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error("handler must not run on an expired write");
      },
    },
  );

function mountedAdmin(store: SessionStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", sameOrigin);
  app.route("/admin", adminApp({ sessionStore: store, db: untouchedDb() as never }));
  return (path: string, init?: RequestInit) => app.request(new URL(path, APP_URL), init, env);
}

const ADMIN_CASES: Array<{ path: string; next: string }> = (
  [
    ["/events", "/admin/events/new"],
    ["/events/abc", "/admin/events/abc"],
    ["/events/abc/publish", "/admin/events/abc"],
    ["/events/abc/cancel", "/admin/events/abc"],
    ["/events/abc/rsvp-pause", "/admin/events/abc"],
    ["/events/abc/rsvp-reopen", "/admin/events/abc"],
    ["/featured", "/admin/featured/new"],
    ["/featured/1", "/admin/featured/1"],
    ["/featured/1/delete", "/admin/featured"],
  ] as Array<[string, string]>
).map(([path, next]) => ({ path: `/admin${path}`, next }));

describe("profiles: dead-session writes recover, retry succeeds, nothing is echoed", () => {
  it("dead JSON PATCH stays 401 with a recovery link, writes nothing, echoes nothing", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    const res = await f.request(`/members/${MEMBER}`, {
      method: "PATCH",
      headers: {
        cookie: dead.cookie,
        origin: f.env.APP_URL,
        referer: `${f.env.APP_URL}/profile?edit=1`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ bio: DRAFT_INPUT, games_text: "Go", timezone: "UTC" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      recovery: "/auth/recover?next=%2Fprofile%3Fedit%3D1",
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(f.state.writes).toBe(0);
    expect(f.profiles.rows.get(MEMBER)?.bio).toBe("Accepted bio");
    expect(JSON.stringify([...res.headers]).includes("Unsaved")).toBe(false);
  });

  it("dead native POST bounces to recovery (never 405), writes nothing, echoes nothing", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    for (const init of [
      {
        body: `_method=PATCH&bio=${encodeURIComponent(DRAFT_INPUT)}`,
        headers: { referer: `${f.env.APP_URL}/profile?edit=1` },
        location: "/auth/recover?next=%2Fprofile%3Fedit%3D1",
      },
      {
        // No _method: a live session would 405, but a dead session recovers first.
        body: `bio=${encodeURIComponent(DRAFT_INPUT)}`,
        headers: { referer: "https://hostile.example/profile" },
        location: "/auth/recover?next=%2Fprofile",
      },
    ]) {
      const res = await f.request(`/members/${MEMBER}`, {
        method: "POST",
        headers: {
          cookie: dead.cookie,
          origin: f.env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
          ...init.headers,
        },
        body: init.body,
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(init.location);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(f.state.writes).toBe(0);
    expect(f.profiles.rows.get(MEMBER)?.bio).toBe("Accepted bio");
    const landing = await f.request("/auth/recover?next=%2Fprofile");
    const html = await landing.text();
    expect(html).toContain("Your earlier changes were not saved");
    expect(html).not.toContain("Unsaved");
    expect(mergeCookies("", landing)).not.toContain("Unsaved");
  });

  it("fresh-session retry after recovery succeeds and the banner lands once", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    try {
      const f = recoveryFixture();
      const dead = await f.login(new Date(0));
      const bounce = await f.request(`/members/${MEMBER}`, {
        method: "PATCH",
        headers: {
          cookie: dead.cookie,
          origin: f.env.APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ bio: DRAFT_INPUT }),
      });
      expect(bounce.status).toBe(401);
      const recovery = (await bounce.json()) as { recovery: string };

      let jar = mergeCookies("", await f.request(recovery.recovery));
      expect(jar).not.toContain("Unsaved");
      const start = await f.request("/auth/discord?next=%2Fprofile%3Fedit%3D1", {
        headers: { cookie: jar },
      });
      jar = mergeCookies(jar, start);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, {
        headers: { cookie: jar },
      });
      expect(callback.headers.get("location")).toBe("/profile?edit=1");
      jar = mergeCookies(jar, callback);
      expect(jar.split("; ").find((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="))).toContain(
        "restored",
      );

      const sessionCookie = jar.split("; ").find((c) => c.startsWith("__Host-two_session="))!;
      const retry = await f.request(`/members/${MEMBER}`, {
        method: "PATCH",
        headers: {
          cookie: sessionCookie,
          origin: f.env.APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ bio: "Recovered bio", games: [], timezone: null }),
      });
      expect(retry.status).toBe(200);
      expect(f.profiles.rows.get(MEMBER)?.bio).toBe("Recovered bio");

      const page = await f.request("/profile?edit=1", { headers: { cookie: jar } });
      const pageHtml = await page.text();
      expect(pageHtml).toContain('data-testid="auth-error"');
      expect(pageHtml).not.toContain("Unsaved");
      jar = mergeCookies(jar, page);
      expect(
        await (await f.request("/profile", { headers: { cookie: jar } })).text(),
      ).not.toContain('data-testid="auth-error"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("admin: every POST bounces on a dead session with no write and no echo", () => {
  it.each(ADMIN_CASES.map((c) => [c.path, c.next] as const))(
    "dead native POST %s → 303 %s, never the write URL",
    async (path, next) => {
      const store = createMemorySessionStore();
      const dead = await bearer(
        store,
        { userId: "100000000000000111", username: "mod", moderator: true },
        new Date(0),
      );
      // No referer: the fallback mapping applies (same shape as
      // test/admin-session-recovery.test.ts). A realistic referer preference is
      // pinned separately below with the GET form page, never the write URL.
      const res = await mountedAdmin(store)(path, {
        method: "POST",
        headers: {
          cookie: dead,
          origin: APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ title: DRAFT_INPUT }),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/auth/recover?next=${encodeURIComponent(next)}`);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get("location")).not.toContain("Unsaved");
    },
  );

  it("a same-origin form referer becomes the recovery destination", async () => {
    const store = createMemorySessionStore();
    const dead = await bearer(
      store,
      { userId: "100000000000000111", username: "mod", moderator: true },
      new Date(0),
    );
    const create = await mountedAdmin(store)("/admin/events", {
      method: "POST",
      headers: {
        cookie: dead,
        origin: APP_URL,
        referer: `${APP_URL}/admin/events/new`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: DRAFT_INPUT }),
    });
    expect(create.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fnew");
    const action = await mountedAdmin(store)("/admin/events/abc/publish", {
      method: "POST",
      headers: {
        cookie: dead,
        origin: APP_URL,
        referer: `${APP_URL}/admin/events/abc`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({}),
    });
    expect(action.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
  });

  it.each(ADMIN_CASES.map((c) => c.path))(
    "dead JSON POST %s stays 401 with a recovery link",
    async (path) => {
      const store = createMemorySessionStore();
      const dead = await bearer(
        store,
        { userId: "100000000000000111", username: "mod", moderator: true },
        new Date(0),
      );
      const next = ADMIN_CASES.find((c) => c.path === path)!.next;
      const res = await mountedAdmin(store)(path, {
        method: "POST",
        headers: {
          cookie: dead,
          origin: APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ title: DRAFT_INPUT }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Unauthorized",
        recovery: `/auth/recover?next=${encodeURIComponent(next)}`,
      });
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it("a live non-moderator still 403s and a live moderator reaches the handler", async () => {
    const store = createMemorySessionStore();
    const pleb = await bearer(store, { userId: "222", username: "pleb", moderator: false });
    const denied = await mountedAdmin(store)("/admin/events", {
      method: "POST",
      headers: {
        cookie: pleb,
        origin: APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: DRAFT_INPUT }),
    });
    expect(denied.status).toBe(403);
    const mod = await bearer(store, {
      userId: "100000000000000111",
      username: "mod",
      moderator: true,
    });
    const live = await mountedAdmin(store)("/admin/events", {
      method: "POST",
      headers: {
        cookie: mod,
        origin: APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: DRAFT_INPUT }),
    });
    // Not a bounce: the handler ran (503 with no admin DB configured).
    expect(live.status).toBe(503);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "admin: fresh-session retry succeeds (requires DATABASE_URL)",
  () => {
    let fixture: MemberDataFixture;
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    it("dead POST writes nothing; the same POST with a fresh session creates the draft", async () => {
      const store = createMemorySessionStore();
      const app = () => {
        const a = new Hono<{ Bindings: Env }>();
        a.use("*", sameOrigin);
        a.route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
        return a;
      };
      const liveEnv = { ...env, ADMIN_DB: fixture.db } as Env;
      const form = (cookie: string) => ({
        method: "POST" as const,
        headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          title: "Recovered headline",
          game: "Chess",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 22:00",
          timezone: "Europe/London",
        }),
      });

      const dead = await bearer(
        store,
        { userId: "100000000000000111", username: "mod", moderator: true },
        new Date(0),
      );
      const bounce = await app().request("/admin/events", form(dead), liveEnv);
      expect(bounce.status).toBe(303);
      expect(bounce.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fnew");
      expect(await fixture.db.select().from(events)).toHaveLength(0);

      const fresh = await bearer(store, {
        userId: "100000000000000111",
        username: "mod",
        moderator: true,
      });
      const retry = await app().request("/admin/events", form(fresh), liveEnv);
      expect(retry.status).toBe(303);
      const rows = await fixture.db.select().from(events);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("Recovered headline");
      await fixture.reset();
    });
  },
);

describe("non-session writes: reasons, never a recovery bounce", () => {
  const prod = (path: string, init?: RequestInit) =>
    production.request(new URL(path, APP_URL), init, { ...env });

  it("POST /logout on a dead bearer still clears and redirects, never bounces to recovery", async () => {
    const store = createMemorySessionStore();
    const deadToken = newSessionToken();
    const dead = (
      await serializeSigned("__Host-two_session", deadToken, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", sameOrigin);
    // Minimal logout: revoke is idempotent, so a missing row still clears.
    app.post("/logout", async (c) => {
      const { hashToken: h } = await import("../src/sessions");
      const { getSignedCookie, deleteCookie } = await import("hono/cookie");
      const token = await getSignedCookie(c, c.env.SESSION_SECRET, "__Host-two_session");
      if (token) await store.revoke(await h(token));
      deleteCookie(c, "__Host-two_session", { path: "/", secure: true });
      return c.redirect("/", 303);
    });
    const res = await app.request(
      "/logout",
      { method: "POST", headers: { cookie: dead, origin: APP_URL } },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-two_session="))).toBe(true);
    void prod;
  });

  it("POST /csp-reports is a session-free sink: always 204 with any cookie", async () => {
    for (const cookie of ["", "__Host-two_session=garbage"]) {
      const res = await prod("/csp-reports", {
        method: "POST",
        headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
        body: JSON.stringify({ "csp-report": { "blocked-uri": "https://example.test/x" } }),
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("POST /api/agent-events ignores a dead session cookie: still the machine ingress refusal", async () => {
    const res = await prod("/api/agent-events", {
      method: "POST",
      headers: {
        cookie: "__Host-two_session=garbage",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "probe" }),
    });
    // Disabled in this env (404 ingress_disabled); when enabled, a missing bearer is still a
    // machine-bearer refusal, never a session recovery bounce.
    expect([400, 401, 403, 404, 422]).toContain(res.status);
    expect(res.headers.get("location")).toBeNull();
    expect((await res.text()).includes("/auth/recover")).toBe(false);
  });

  it("POST /__probe/alert ignores a dead session cookie: still the staging-token 404", async () => {
    const res = await prod("/__probe/alert", {
      method: "POST",
      headers: {
        cookie: "__Host-two_session=garbage",
        origin: APP_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("POST /auth/qa/:identity without staging QA stays 404 with a dead session cookie", async () => {
    const res = await prod("/auth/qa/member", {
      method: "POST",
      headers: { cookie: "__Host-two_session=garbage", origin: APP_URL, "x-qa-token": "wrong" },
    });
    expect(res.status).toBe(404);
  });
});
