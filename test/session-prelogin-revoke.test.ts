// route-inventory: GET /auth/discord/callback
// route-inventory: GET /join/callback
// route-inventory: GET /auth/status
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import type { Env } from "../src/env";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import type { JoinRouteDeps } from "../src/join/route";

// TOG-12284 (session-fixation parity; red proof recorded on TOG-12273): a fresh
// login revokes the presented pre-login/pre-join session — and any other live
// session for the same user — so only the newest session survives. Liveness is
// probed via /auth/status (non-rotating); probing via / would rotate the token
// and false-pass.

const SECRET = "test-session-secret-at-least-32-bytes-long";
const SESSION_COOKIE = "__Host-two_session";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
  DISCORD_MODERATOR_ROLE_IDS: "",
};

const jarOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const bearerOf = (res: Response) =>
  decodeURIComponent(
    jarOf(res).split("; ").find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.slice(SESSION_COOKIE.length + 1),
  ).split(".")[0]!;

function isolated() {
  const store = createMemorySessionStore();
  return { store, env: { ...env, SESSION_STORE: store } as Env };
}

/** Mint a pre-login session row and return its bearer cookie jar (session + status probe). */
async function mintPreLogin(store: SessionStore, userId = "42") {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({
    tokenHash,
    userId,
    username: "Pre-login member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const session = (await serializeSigned(SESSION_COOKIE, token, SECRET, { path: "/", secure: true })).split(";")[0]!;
  const status = (await serializeSigned(AUTH_STATUS_COOKIE, tokenHash, SECRET, { path: "/", secure: true })).split(
    ";",
  )[0]!;
  return { token, tokenHash, jar: `${session}; ${status}` };
}

function mockDiscord() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/42")) return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

async function discordLogin(e: Env, presentedCookie: string) {
  const start = await app.request("/auth/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = [jarOf(start), presentedCookie].filter(Boolean).join("; ");
  return app.request(`/auth/discord/callback?code=abc&state=${state}`, { headers: { cookie } }, e);
}

// In-memory Sql double for the join journey's two statements (same contract as
// test/join.test.ts: only the throttle/attempt queries the callback emits).
function fakeSql() {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: { outcome: string; source: string | null; requestId: string | null; discordId: string | null }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = throttle.filter((r) => r.bucket === bucket && r.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(1, Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000));
      return [{ n: rows.length, wait }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      const [outcome, source, requestId, discordId] = values as [string, string | null, string | null, string | null];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, throttle, attempts };
}

function isolatedJoin(deps: Partial<JoinRouteDeps> = {}) {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql, ...deps },
  } as unknown as Env;
  return { store, fake, env: e };
}

afterEach(() => vi.unstubAllGlobals());

describe("pre-login session revocation on fresh login", () => {
  it("a fresh ordinary login revokes the presented pre-login session", async () => {
    const { store, env: e } = isolated();
    mockDiscord();
    const pre = await mintPreLogin(store);
    expect(await store.get(pre.tokenHash)).not.toBeNull();
    expect(await (await app.request("/auth/status", { headers: { cookie: pre.jar } }, e)).json()).toEqual({
      authenticated: true,
    });

    const login = await discordLogin(e, pre.jar);
    expect(login.status).toBe(302);

    expect(await store.get(pre.tokenHash)).toBeNull();
    expect(await (await app.request("/auth/status", { headers: { cookie: pre.jar } }, e)).json()).toEqual({
      authenticated: false,
    });
    // The fresh session itself is live.
    expect(await store.get(await hashToken(bearerOf(login)))).not.toBeNull();
  });

  it("a fresh join sign-in revokes the presented pre-join session", async () => {
    const { store, env: e } = isolatedJoin();
    mockDiscord();
    const pre = await mintPreLogin(store);
    expect(await (await app.request("/auth/status", { headers: { cookie: pre.jar } }, e)).json()).toEqual({
      authenticated: true,
    });

    const start = await app.request("/join/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await app.request(`/join/callback?code=abc&state=${state}`, {
      headers: { cookie: `${jarOf(start)}; ${pre.jar}` },
    }, e);
    expect(cb.headers.get("location")).toBe("/?n=joined");

    expect(await store.get(pre.tokenHash)).toBeNull();
    expect(await (await app.request("/auth/status", { headers: { cookie: pre.jar } }, e)).json()).toEqual({
      authenticated: false,
    });
    expect(await store.get(await hashToken(bearerOf(cb)))).not.toBeNull();
  });

  it("a presented session from another user is revoked too (shared terminal)", async () => {
    // The presented token belongs to user 43, the fresh login to user 42: the
    // same-user sweep cannot reach it, so only the explicit presented-token
    // revoke kills it.
    const { store, env: e } = isolated();
    mockDiscord();
    const pre = await mintPreLogin(store, "43");
    const login = await discordLogin(e, pre.jar);
    expect(login.status).toBe(302);

    expect(await store.get(pre.tokenHash)).toBeNull();
    expect(await (await app.request("/auth/status", { headers: { cookie: pre.jar } }, e)).json()).toEqual({
      authenticated: false,
    });
    expect(await store.get(await hashToken(bearerOf(login)))).not.toBeNull();
  });

  it("concurrent logins leave only the newest session live", async () => {
    const { store, env: e } = isolated();
    mockDiscord();
    const first = await discordLogin(e, "");
    const second = await discordLogin(e, "");
    const hashA = await hashToken(bearerOf(first));
    const hashB = await hashToken(bearerOf(second));
    expect(hashA).not.toBe(hashB);

    expect(await store.get(hashA)).toBeNull();
    expect(await store.get(hashB)).not.toBeNull();
    expect(await (await app.request("/auth/status", { headers: { cookie: jarOf(first) } }, e)).json()).toEqual({
      authenticated: false,
    });
    expect(await (await app.request("/auth/status", { headers: { cookie: jarOf(second) } }, e)).json()).toEqual({
      authenticated: true,
    });
  });
});
