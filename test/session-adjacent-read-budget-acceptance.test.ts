// The session-adjacent GETs (/auth/status, /auth/recover, /events.json) share
// the one public-read budget with every other read: admitted behavior is
// unchanged, an exhausted budget answers the shared 429 shape with Retry-After
// before any session/cookie/DB work, a limiter outage degrades to allow, and
// refused requests record no hit. Acceptance-owned: the build makes this suite
// green without editing it; corrections return to its author.
//
// Hermetic: memory throttle ledger plus memory session store, no database rows
// (dbFor resolves null), no network. Mounts the production app so the guard
// placement under test is the real registration, not a re-wired copy.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import { PUBLIC_EVENT_READS_PER_MINUTE } from "../src/events/routes-shared";
import production from "../src/index";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const IP = "192.0.2.99";
const APP_URL = "https://next.example.test";
const SECRET = "session-adjacent-acceptance-secret-32b-plus";
const MEMBER = "100000000000000001";
const WAIT = 60;

// Real admission transaction over a local statement double, one bucket shared
// by the sibling pages and the three session-adjacent reads.
function fixture() {
  let now = Date.now();
  const hits: { bucket: string; at: number }[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
        return [
          {
            n: rows.length,
            wait: rows.length ? Math.ceil((rows[0]!.at + 60_000 - now) / 1000) : 1,
          },
        ];
      }
      if (statement.includes("INSERT INTO web_throttle_hits")) {
        hits.push({ bucket: String(values[0]), at: now });
        return [];
      }
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  const sessions = createMemorySessionStore();
  const eventStore = vi.fn(() => null);
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", production);
  const env = {
    APP_URL,
    SESSION_SECRET: SECRET,
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    SESSION_STORE: sessions,
    THROTTLE_STORE: async () => sql as unknown as Sql,
    get ADMIN_DB() {
      return eventStore();
    },
  } as unknown as EnvWithThrottle;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      new URL(path, APP_URL),
      { ...init, headers: { "cf-connecting-ip": IP, ...init.headers } },
      env,
    );
  const exhaust = async () => {
    for (let n = 0; n < PUBLIC_EVENT_READS_PER_MINUTE; n++) {
      const response = await request(`/events?q=probe${n}`);
      expect(response.status).not.toBe(429);
    }
  };
  const login = async () => {
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    await sessions.create({
      tokenHash,
      userId: MEMBER,
      username: "Fixture member",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(now + 3_600_000),
    });
    const options = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;
    const cookie = (await serializeSigned(SESSION_COOKIE, token, SECRET, options)).split(";")[0]!;
    const statusKey = (await sessions.statusHash(tokenHash))!;
    const probe = (await serializeSigned(AUTH_STATUS_COOKIE, statusKey, SECRET, options)).split(
      ";",
    )[0]!;
    return { tokenHash, cookie, probe };
  };
  return {
    request,
    exhaust,
    hits,
    sessions,
    login,
    eventStore,
    env,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-adjacent reads on the shared budget", () => {
  it("keeps admitted /auth/status behavior: guests false, members true, no rotation or cookies", async () => {
    const f = fixture();
    const guest = await f.request("/auth/status");
    expect(guest.status).toBe(200);
    expect(await guest.json()).toEqual({ authenticated: false });
    expect(guest.headers.get("cache-control")).toBe("no-store, private");
    expect(guest.headers.get("vary")).toBe("Cookie");
    expect(guest.headers.getSetCookie()).toEqual([]);

    const member = await f.login();
    const res = await f.request("/auth/status", {
      headers: { cookie: `${member.cookie}; ${member.probe}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await f.sessions.get(member.tokenHash)).not.toBeNull();
  });

  it("keeps the auth-status outage contract: a session-store failure is 503, never a logout", async () => {
    const f = fixture();
    const member = await f.login();
    const jar = `${member.cookie}; ${member.probe}`;
    vi.spyOn(f.sessions, "isActive").mockRejectedValueOnce(new Error("storage unavailable"));
    const outage = await f.request("/auth/status", { headers: { cookie: jar } });
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ authenticated: false });
    const healthy = await f.request("/auth/status", { headers: { cookie: jar } });
    expect(await healthy.json()).toEqual({ authenticated: true });
    expect(await f.sessions.get(member.tokenHash)).not.toBeNull();
  });

  it("keeps admitted /auth/recover behavior: landing copy plus the two pending cookies", async () => {
    const f = fixture();
    const res = await f.request("/auth/recover?next=%2Fprofile%3Fedit%3D1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
    const html = await res.text();
    expect(html).toContain("Your earlier changes were not saved");
    expect(html).toContain('href="/auth/discord?next=%2Fprofile%3Fedit%3D1"');
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(2);
    const joined = set.join("\n");
    expect(joined).toContain("__Host-two_login_intended=");
    expect(joined).toContain("__Host-two_expired_write=");
    expect(joined).toContain("pending");
    for (const cookie of set) {
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Max-Age=600");
      expect(cookie).toContain("Path=/");
    }
  });

  it("keeps recover next revalidation: hostile destinations fall back to /profile", async () => {
    const f = fixture();
    const res = await f.request(
      "/auth/recover?next=" + encodeURIComponent("https://evil.example/"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/auth/discord?next=%2Fprofile"');
  });

  it("keeps admitted /events.json behavior: guests 401, members reach the DB layer", async () => {
    const f = fixture();
    const guest = await f.request("/events.json");
    expect(guest.status).toBe(401);
    expect(await guest.json()).toEqual({ error: "unauthenticated" });
    const member = await f.login();
    const res = await f.request("/events.json", { headers: { cookie: member.cookie } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "db_unavailable" });
  });

  it("throttles /auth/status on an exhausted shared budget with the JSON envelope", async () => {
    const f = fixture();
    const member = await f.login();
    await f.exhaust();
    const isActive = vi.spyOn(f.sessions, "isActive");
    const get = vi.spyOn(f.sessions, "get");
    const statusHash = vi.spyOn(f.sessions, "statusHash");
    const res = await f.request("/auth/status", {
      headers: { accept: "application/json", cookie: `${member.cookie}; ${member.probe}` },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(WAIT));
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = (await res.json()) as { request_id?: unknown };
    expect(body).toMatchObject({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${WAIT} seconds.`,
      retry_after: WAIT,
    });
    expect(typeof body.request_id).toBe("string");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(isActive).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(statusHash).not.toHaveBeenCalled();
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("throttles /auth/status for default-Accept callers with status plus Retry-After", async () => {
    const f = fixture();
    await f.exhaust();
    const res = await f.request("/auth/status");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(WAIT));
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("throttles /auth/recover with the branded page and plants no cookies", async () => {
    const f = fixture();
    await f.exhaust();
    const res = await f.request("/auth/recover?next=%2Fprofile");
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("retry-after")).toBe(String(WAIT));
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = await res.text();
    expect(body).toContain("Slow down a little");
    expect(body).not.toContain("Your earlier changes were not saved");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("throttles /events.json with the JSON envelope before session and DB reads", async () => {
    const f = fixture();
    const member = await f.login();
    await f.exhaust();
    const get = vi.spyOn(f.sessions, "get");
    f.eventStore.mockClear();
    const res = await f.request("/events.json", { headers: { cookie: member.cookie } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(WAIT));
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const body = (await res.json()) as { request_id?: unknown };
    expect(body).toMatchObject({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${WAIT} seconds.`,
      retry_after: WAIT,
    });
    expect(typeof body.request_id).toBe("string");
    expect(get).not.toHaveBeenCalled();
    expect(f.eventStore).not.toHaveBeenCalled();
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("spends one shared hit per admitted session-adjacent read", async () => {
    for (const path of ["/auth/status", "/auth/recover?next=%2Fprofile", "/events.json"]) {
      const f = fixture();
      const res = await f.request(path);
      expect(res.status, path).not.toBe(429);
      expect(f.hits, path).toHaveLength(1);
      expect(f.hits[0]!.bucket, path).toBe(`events-read:${IP}`);
    }
  });

  it("shares one budget across the new reads and the sibling pages", async () => {
    const f = fixture();
    for (let n = 0; n < 20; n++) {
      expect((await f.request("/auth/status")).status).toBe(200);
      expect((await f.request("/auth/recover?next=%2Fprofile")).status).toBe(200);
      expect((await f.request("/events.json")).status).toBe(401);
    }
    expect(f.hits).toHaveLength(60);
    expect(new Set(f.hits.map((hit) => hit.bucket))).toEqual(new Set([`events-read:${IP}`]));
    const sibling = await f.request("/events?q=chess", { headers: { accept: "application/json" } });
    expect(sibling.status).toBe(429);
    const body = (await sibling.json()) as { request_id?: unknown };
    expect(body).toMatchObject({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${WAIT} seconds.`,
      retry_after: WAIT,
    });
    expect(typeof body.request_id).toBe("string");
  });

  it("records no hit for refused retries on any of the three routes", async () => {
    const f = fixture();
    await f.exhaust();
    for (let n = 0; n < 3; n++) {
      expect(
        (await f.request("/auth/status", { headers: { accept: "application/json" } })).status,
      ).toBe(429);
      expect((await f.request("/auth/recover?next=%2Fprofile")).status).toBe(429);
      expect((await f.request("/events.json")).status).toBe(429);
    }
    expect(f.hits).toHaveLength(PUBLIC_EVENT_READS_PER_MINUTE);
  });

  it("admits the three routes again after the 60-second window", async () => {
    const f = fixture();
    await f.exhaust();
    expect(
      (await f.request("/auth/status", { headers: { accept: "application/json" } })).status,
    ).toBe(429);
    f.advance(60_001);
    expect((await f.request("/auth/status")).status).toBe(200);
    expect((await f.request("/auth/recover?next=%2Fprofile")).status).toBe(200);
    expect((await f.request("/events.json")).status).toBe(401);
  });

  it("degrades to allow when the limiter store is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fixture();
      f.env.THROTTLE_STORE = async () => null;
      const status = await f.request("/auth/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ authenticated: false });
      expect((await f.request("/auth/recover?next=%2Fprofile")).status).toBe(200);
      expect((await f.request("/events.json")).status).toBe(401);
      expect(f.hits).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("degrades to allow when the limiter store throws, without exposing diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fixture();
      f.env.THROTTLE_STORE = async () => {
        throw new Error("private driver diagnostic");
      };
      const status = await f.request("/auth/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ authenticated: false });
      const recover = await f.request("/auth/recover?next=%2Fprofile");
      expect(recover.status).toBe(200);
      expect(await recover.text()).toContain("Your earlier changes were not saved");
      const json = await f.request("/events.json");
      expect(json.status).toBe(401);
      expect(f.hits).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
      for (const call of warn.mock.calls) {
        const logged = JSON.stringify(call);
        expect(logged).not.toContain(IP);
        expect(logged).not.toContain("private driver diagnostic");
      }
    } finally {
      warn.mockRestore();
    }
  });
});
