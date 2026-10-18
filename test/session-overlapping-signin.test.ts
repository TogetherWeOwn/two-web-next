// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /auth/status
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  type SessionStore,
  type Sql,
} from "../src/sessions";

// Overlapping fresh sign-ins (acceptance): two same-user, distinct-journey
// OAuth callbacks that are genuinely in flight at the same time must behave
// like some serialized issuance order — the last serialized issuer stays
// live, the previous issuer is revoked, and two successful callbacks never
// leave BOTH fresh tokens inactive.
//
// The interleaving under test, at the store boundary:
//   A inserts fresh token A -> B inserts fresh token B -> A sweeps "every
//   other session" -> B sweeps "every other session".
// With a naive insert-then-sweep per callback, A's sweep revokes B and B's
// sweep revokes A: both members hold dead cookies after a successful login.
//
// The latch below holds the first callback at its sweep step (after its
// fresh token is inserted) until the second callback has also inserted, so
// the overlap is deterministic rather than a scheduling coin-flip. The hold
// is bounded: an implementation that serializes issuance (so the second
// insert legitimately cannot happen while the first callback is held) is
// released by the timeout and then judged purely on the final state, which
// is the serialized-equivalence assertion at the end of each case.
// Liveness is probed via /auth/status (non-rotating) and store.get on the
// token hash; probing via / would rotate the token and false-pass.

const SECRET = "test-session-secret-at-least-32-bytes-long";
const SESSION_COOKIE = "__Host-two_session";
const HOLD_MS = 1_500;

const baseEnv: Env = {
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
    jarOf(res)
      .split("; ")
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .slice(SESSION_COOKIE.length + 1),
  ).split(".")[0]!;

/** Discord double: the OAuth `code` picks the user (`code-<userId>`). */
function mockDiscord() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) {
        const code = new URLSearchParams(String(init?.body ?? "")).get("code") ?? "";
        return Response.json({ access_token: `at-${code}` });
      }
      if (url.endsWith("/users/@me")) {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        const id = auth.replace("Bearer at-code-", "");
        return Response.json({
          id,
          username: `user${id}`,
          global_name: `User ${id}`,
          avatar: null,
        });
      }
      if (url.includes("/members/") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

/**
 * Wrap a store so overlapping issuances are forced into the
 * insert/insert/sweep/sweep interleaving (see header). `inserted` resolves
 * with the running count after each fresh insert; the sweep step waits —
 * at most HOLD_MS — until two inserts have been observed.
 */
function latchedStore(inner: SessionStore, shared?: ReturnType<typeof newLatch>) {
  const latch = shared ?? newLatch();
  const noteInsert = () => {
    latch.inserts += 1;
    latch.notify();
  };
  const store: SessionStore = {
    ...inner,
    create: async (session) => {
      await inner.create(session);
      noteInsert();
    },
    replace: async (oldTokenHash, replacement) => {
      await inner.replace(oldTokenHash, replacement);
      noteInsert();
    },
    revokeUserSessions: async (userId, exceptTokenHash) => {
      if (latch.armed) {
        await Promise.race([
          latch.untilInserts(2),
          new Promise((resolve) => setTimeout(resolve, HOLD_MS)),
        ]);
      }
      await inner.revokeUserSessions(userId, exceptTokenHash);
    },
  };
  return { store, latch };
}

function newLatch() {
  const waiters = new Set<() => void>();
  const latch = {
    armed: false,
    inserts: 0,
    notify() {
      for (const wake of [...waiters]) wake();
    },
    untilInserts(n: number): Promise<void> {
      if (latch.inserts >= n) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = () => {
          if (latch.inserts >= n) {
            waiters.delete(check);
            resolve();
          }
        };
        waiters.add(check);
      });
    },
  };
  return latch;
}

async function startJourney(e: Env, userId: string) {
  const start = await app.request("/auth/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return () =>
    app.request(
      `/auth/discord/callback?code=code-${userId}&state=${state}`,
      { headers: { cookie: jarOf(start) } },
      e,
    );
}

const statusOf = async (e: Env, res: Response) =>
  (await (await app.request("/auth/status", { headers: { cookie: jarOf(res) } }, e)).json()) as {
    authenticated: boolean;
  };

afterEach(() => vi.unstubAllGlobals());

describe("overlapping fresh sign-ins (memory store)", () => {
  it("two overlapping same-user callbacks never leave both fresh tokens inactive", async () => {
    const { store, latch } = latchedStore(createMemorySessionStore());
    const e = { ...baseEnv, SESSION_STORE: store } as Env;
    mockDiscord();

    const callbackA = await startJourney(e, "42");
    const callbackB = await startJourney(e, "42");

    latch.armed = true;
    const pendingA = callbackA();
    // A is genuinely in flight with its fresh token inserted before B starts.
    await latch.untilInserts(1);
    const pendingB = callbackB();
    const [resA, resB] = await Promise.all([pendingA, pendingB]);
    latch.armed = false;

    expect(resA.status).toBe(302);
    expect(resB.status).toBe(302);
    const hashA = await hashToken(bearerOf(resA));
    const hashB = await hashToken(bearerOf(resB));
    expect(hashA).not.toBe(hashB);

    // Serialized equivalence, newest issuer (B) wins: exactly one live token.
    // The defect under test leaves hashA AND hashB both revoked here.
    expect(await store.get(hashA)).toBeNull();
    expect(await store.get(hashB)).not.toBeNull();
    expect(await statusOf(e, resA)).toEqual({ authenticated: false });
    expect(await statusOf(e, resB)).toEqual({ authenticated: true });
  });

  it("control: sequential logins still leave only the newest session live", async () => {
    const store = createMemorySessionStore();
    const e = { ...baseEnv, SESSION_STORE: store } as Env;
    mockDiscord();

    const resA = await (await startJourney(e, "42"))();
    const resB = await (await startJourney(e, "42"))();
    expect(resA.status).toBe(302);
    expect(resB.status).toBe(302);

    expect(await store.get(await hashToken(bearerOf(resA)))).toBeNull();
    expect(await store.get(await hashToken(bearerOf(resB)))).not.toBeNull();
    expect(await statusOf(e, resA)).toEqual({ authenticated: false });
    expect(await statusOf(e, resB)).toEqual({ authenticated: true });

    // Signed fresh-session cookie keeps its attributes.
    const setCookie = resB.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("control: overlapping different-user callbacks both stay live (no cross-user sweep or global lock)", async () => {
    const { store, latch } = latchedStore(createMemorySessionStore());
    const e = { ...baseEnv, SESSION_STORE: store } as Env;
    mockDiscord();

    const callbackA = await startJourney(e, "42");
    const callbackB = await startJourney(e, "43");

    latch.armed = true;
    const pendingA = callbackA();
    await latch.untilInserts(1);
    const pendingB = callbackB();
    // No global cross-user serialization: user 43's insert must land while
    // user 42's callback is still held at its sweep step (the latch only
    // releases that hold on the second insert, or after HOLD_MS).
    await Promise.race([
      latch.untilInserts(2),
      new Promise((resolve) => setTimeout(resolve, HOLD_MS / 2)),
    ]);
    expect(latch.inserts).toBe(2);
    const [resA, resB] = await Promise.all([pendingA, pendingB]);
    latch.armed = false;

    expect(resA.status).toBe(302);
    expect(resB.status).toBe(302);
    expect(await store.get(await hashToken(bearerOf(resA)))).not.toBeNull();
    expect(await store.get(await hashToken(bearerOf(resB)))).not.toBeNull();
    expect(await statusOf(e, resA)).toEqual({ authenticated: true });
    expect(await statusOf(e, resB)).toEqual({ authenticated: true });
  });
});

// Real store coordination: two independent Postgres clients (two pools, so
// the callbacks really can interleave at the database) against the guarded
// disposable test database. Skipped when DATABASE_URL is absent, like
// test/e2e-db.test.ts.
const url = process.env.DATABASE_URL;
describe.skipIf(!url)("overlapping fresh sign-ins (Postgres, two connections)", () => {
  const sqlA = postgres(url!, { max: 4 }) as unknown as Sql & { end: () => Promise<void> };
  const sqlB = postgres(url!, { max: 4 }) as unknown as Sql & { end: () => Promise<void> };

  beforeAll(async () => migrate(sqlA));
  afterAll(async () => {
    await sqlA.end();
    await sqlB.end();
  });
  afterEach(async () => {
    await (sqlA as unknown as ReturnType<typeof postgres>)`
      delete from web_sessions where user_id in ('42', '43')`;
  });

  it("two overlapping same-user callbacks on separate connections leave exactly the newest token live, hash-only", async () => {
    const latch = newLatch();
    const a = latchedStore(createPostgresSessionStore(sqlA), latch);
    const b = latchedStore(createPostgresSessionStore(sqlB), latch);
    const envA = { ...baseEnv, SESSION_STORE: a.store } as Env;
    const envB = { ...baseEnv, SESSION_STORE: b.store } as Env;
    mockDiscord();
    await (sqlA as unknown as ReturnType<typeof postgres>)`
      delete from web_sessions where user_id in ('42', '43')`;

    const callbackA = await startJourney(envA, "42");
    const callbackB = await startJourney(envB, "42");

    latch.armed = true;
    const pendingA = callbackA();
    await latch.untilInserts(1);
    const pendingB = callbackB();
    const [resA, resB] = await Promise.all([pendingA, pendingB]);
    latch.armed = false;

    expect(resA.status).toBe(302);
    expect(resB.status).toBe(302);
    const tokenA = bearerOf(resA);
    const tokenB = bearerOf(resB);
    const hashA = await hashToken(tokenA);
    const hashB = await hashToken(tokenB);

    const probe = createPostgresSessionStore(sqlA);
    expect(await probe.get(hashA)).toBeNull();
    expect(await probe.get(hashB)).not.toBeNull();
    expect(await statusOf(envA, resA)).toEqual({ authenticated: false });
    expect(await statusOf(envB, resB)).toEqual({ authenticated: true });

    // Hash-only persistence: stored keys are hashes, never bearer tokens.
    const rows = await (sqlA as unknown as ReturnType<typeof postgres>)<
      { token_hash: string; status_hash: string | null }[]
    >`select token_hash, status_hash from web_sessions where user_id = '42'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toBe(tokenA);
      expect(row.token_hash).not.toBe(tokenB);
      if (row.status_hash !== null) expect(row.status_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
