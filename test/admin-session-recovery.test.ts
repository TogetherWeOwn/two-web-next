// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key
// route-inventory: POST /admin/featured
// route-inventory: GET /admin
// Expired-session recovery for admin writes (TOG-12399): a bearer with no
// live row is an expired guest, not a forbidden member. Native form POSTs
// bounce through expiredWriteBounce to a safe GET destination with no write;
// GET guests keep the bare login redirect; JSON callers keep 401 with a
// recovery link. The tab-sync probe runs on moderator reads so the editor
// island can keep the draft reachable, and the one-shot banner lands once.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import production from "../src/index";
import { adminApp } from "../src/admin/routes";
import { sameOrigin } from "../src/same-origin";
import { ADMIN_SESSION_EXPIRED_COPY, ADMIN_SESSION_EXPIRED_TESTID } from "../src/islands/contracts";
import type { Env } from "../src/env";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { eventEditorBrowser } from "./helpers/admin-event-editor";
import { fixtureDiscord, MEMBER, mergeCookies, recoveryFixture } from "./fixtures/session-recovery";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const MOD_ROLE = "100000000000000010";

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

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
  token = newSessionToken(),
): Promise<{ cookie: string; tokenHash: string }> {
  const tokenHash = await hashToken(token);
  await store.create({
    tokenHash,
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return { cookie: serialized.split(";")[0]!, tokenHash };
}

/** Any store touch throws: a 303 proves the guard bounced before the handler. */
const untouchedDb = () =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error("admin handler must not run on an expired write");
      },
    },
  );

/** Mounted like production (same-origin gate + /admin prefix), minus the DB. */
function mountedApp(store: SessionStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", sameOrigin);
  app.route("/admin", adminApp({ sessionStore: store, db: untouchedDb() as never }));
  const request = (path: string, init?: RequestInit) =>
    app.request(new URL(path, APP_URL), init, env);
  return { request };
}

function appWithStore(store: SessionStore) {
  // Sessions resolve from memory; the admin tables stay unconfigured, which is
  // enough: the bounce happens in the guard, and the dashboard degrades.
  return {
    request: (path: string, init?: RequestInit) =>
      production.request(new URL(path, APP_URL), init, { ...env, SESSION_STORE: store }),
  };
}

describe("expired admin writes recover instead of 403ing", () => {
  it("a revoked moderator bearer POST bounces to recovery with the edit page, touching no store", async () => {
    const store = createMemorySessionStore();
    const { cookie, tokenHash } = await cookieFor(store, {
      userId: "100000000000000111",
      username: "mod",
      moderator: true,
    });
    await store.revoke(tokenHash);
    const { request } = mountedApp(store);
    const res = await request("/admin/events/abc", {
      method: "POST",
      headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "Unsaved draft" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ["/events", "/admin/events/new"],
    ["/events/abc", "/admin/events/abc"],
    ["/events/abc/publish", "/admin/events/abc"],
    ["/events/abc/cancel", "/admin/events/abc"],
    ["/events/abc/rsvp-pause", "/admin/events/abc"],
    ["/events/abc/rsvp-reopen", "/admin/events/abc"],
    ["/featured", "/admin/featured/new"],
    ["/featured/1", "/admin/featured/1"],
    ["/featured/1/delete", "/admin/featured"],
  ])("maps POST %s onto GET %s, never the write URL", async (path, next) => {
    const store = createMemorySessionStore();
    const res = await mountedApp(store).request(`/admin${path}`, {
      method: "POST",
      headers: { origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "x" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/auth/recover?next=${encodeURIComponent(next)}`);
  });

  it("prefers the same-origin edit page the form posted from", async () => {
    const store = createMemorySessionStore();
    const res = await mountedApp(store).request("/admin/events", {
      method: "POST",
      headers: {
        origin: APP_URL,
        referer: `${APP_URL}/admin/events/new`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: "x" }),
    });
    expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fnew");
  });

  it("a hostile referer falls back to the mapped page, never off-app", async () => {
    const store = createMemorySessionStore();
    const res = await mountedApp(store).request("/admin/events/abc", {
      method: "POST",
      headers: {
        origin: APP_URL,
        referer: "https://evil.example/admin/events/abc",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: "x" }),
    });
    expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
  });

  it("an expired JSON write stays 401 with a recovery link", async () => {
    const store = createMemorySessionStore();
    const res = await mountedApp(store).request("/admin/events/abc", {
      method: "POST",
      headers: {
        origin: APP_URL,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      recovery: "/auth/recover?next=%2Fadmin%2Fevents%2Fabc",
    });
  });

  it("a hostile recovery next on the landing falls back to the member default", async () => {
    const { request } = appWithStore(createMemorySessionStore());
    const res = await request(
      "/auth/recover?next=" + encodeURIComponent("https://evil.example/admin"),
    );
    expect(await res.text()).toContain('href="/auth/discord?next=%2Fprofile"');
  });

  it("a signed-in non-moderator write still 403s, and a live moderator write reaches the handler", async () => {
    const store = createMemorySessionStore();
    const pleb = await cookieFor(store, { userId: "222", username: "pleb", moderator: false });
    const denied = await mountedApp(store).request("/admin/events", {
      method: "POST",
      headers: {
        cookie: pleb.cookie,
        origin: APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: "x" }),
    });
    expect(denied.status).toBe(403);
    const mod = await cookieFor(store, {
      userId: "100000000000000111",
      username: "mod",
      moderator: true,
    });
    const live = await mountedApp(store).request("/admin/events", {
      method: "POST",
      headers: {
        cookie: mod.cookie,
        origin: APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: "x" }),
    });
    // Not a bounce: the handler ran (and 503s with no admin DB configured).
    expect(live.status).toBe(503);
  });

  it("GET guests keep the bare login bounce and moderator reads mount the tab-sync probe", async () => {
    const store = createMemorySessionStore();
    const guest = await adminApp(store).request("/events/new", {}, env);
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/auth/discord");
    const mod = await cookieFor(store, {
      userId: "100000000000000111",
      username: "mod",
      moderator: true,
    });
    const page = await appWithStore(store).request("/admin", { headers: { cookie: mod.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-testid="auth-tab-sync"');
  });
});

describe("admin recovery round trip", () => {
  const moderatorDiscord = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input).replace("https://discord.com/api/v10/", "https://discord.com/api/");
    if (url.includes(`/guilds/326474832151838730/members/${MEMBER}`)) {
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      return Response.json({ roles: [MOD_ROLE], joined_at: "2024-01-01T00:00:00Z" });
    }
    return fixtureDiscord(input, init);
  };

  it("expired POST, recovery landing, moderator login, banner exactly once", async () => {
    vi.stubGlobal("fetch", moderatorDiscord);
    try {
      const f = recoveryFixture("https://next.example.test", {
        DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
      });
      const dead = await f.login(new Date(0));
      const bounce = await f.request("/admin/events/abc", {
        method: "POST",
        headers: {
          cookie: dead.cookie,
          origin: f.env.APP_URL,
          referer: f.env.APP_URL + "/admin/events/abc",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ title: "Unsaved draft" }),
      });
      expect(bounce.status).toBe(303);
      expect(bounce.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
      expect(f.state.writes).toBe(0);

      let jar = mergeCookies("", await f.request(bounce.headers.get("location")!));
      const start = await f.request("/auth/discord?next=%2Fadmin%2Fevents%2Fabc", {
        headers: { cookie: jar },
      });
      jar = mergeCookies(jar, start);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, {
        headers: { cookie: jar },
      });
      expect(callback.headers.get("location")).toBe("/admin/events/abc");
      jar = mergeCookies(jar, callback);

      const only = (name: string) => jar.split("; ").find((c) => c.startsWith(name + "="))!;
      expect(only(EXPIRED_WRITE_COOKIE)).toContain("restored");
      const page = await f.request("/admin", { headers: { cookie: jar } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('data-testid="auth-error"');
      jar = mergeCookies(jar, page);
      expect(await (await f.request("/admin", { headers: { cookie: jar } })).text()).not.toContain(
        'data-testid="auth-error"',
      );
      expect(f.state.writes).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("admin editor session-expiry island", () => {
  it("ships the expiry listener with the editor binder", () => {
    const js = readFileSync("public/islands/admin-event-editor.js", "utf8");
    expect(js).toContain('addEventListener("two:session-expired"');
    expect(js).toContain(ADMIN_SESSION_EXPIRED_TESTID);
  });

  it("vetoes the probe reload, keeps the draft, and shows the durable notice with the recovery link", () => {
    const b = eventEditorBrowser({});
    b.values.set("title", "Unsaved headline");
    const expired = b.expireSession();
    expect(expired.preventDefault).toHaveBeenCalledOnce();
    const notice = b.created.find((el) => el.attrs["data-testid"] === ADMIN_SESSION_EXPIRED_TESTID);
    expect(notice).toBeDefined();
    expect(notice!.attrs.role).toBe("alert");
    expect(notice!.textContent).toContain(ADMIN_SESSION_EXPIRED_COPY);
    expect(notice!.children).toHaveLength(1);
    expect(notice!.children[0]!.tag).toBe("a");
    expect(notice!.children[0]!.href).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
    expect(notice!.children[0]!.textContent).toBe("Sign in again");
    expect(notice!.focused).toBe(true);
    expect(b.inserted).toHaveLength(1);
    expect(b.inserted[0]!.before).toBe(b.editor);
    // The draft is untouched and the notice renders only once.
    expect(b.values.get("title")).toBe("Unsaved headline");
    b.expireSession();
    expect(
      b.created.filter((el) => el.attrs["data-testid"] === ADMIN_SESSION_EXPIRED_TESTID),
    ).toHaveLength(1);
  });

  it("releases the dirty guard for the recovery trip but keeps prompting otherwise", () => {
    const guarded = eventEditorBrowser({});
    guarded.values.set("title", "Unsaved headline");
    expect(guarded.navigate("sort").preventDefault).toHaveBeenCalledOnce();
    guarded.expireSession();
    expect(guarded.navigate("sort").preventDefault).not.toHaveBeenCalled();
    const clean = eventEditorBrowser({});
    clean.expireSession();
    expect(clean.navigate("sort").preventDefault).not.toHaveBeenCalled();
  });
});
