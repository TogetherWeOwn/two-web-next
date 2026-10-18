// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /auth/status
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  type SessionStore,
  type Sql,
} from "../src/sessions";

// Fresh-login sweep scope (acceptance): every fresh sign-in sweeps the
// user's other sessions so only the newest login stays live. That sweep
// (`revokeUserSessions`, reached on each sign-in through the session
// issuance path) must revoke only UNEXPIRED predecessors. Rows that are
// already expired are dead by expiry, not by revocation: the sweep must
// leave them untouched — in Postgres their `revoked_at` stays null (the
// expired-row pruner owns their removal) — no matter how long ago they
// expired or how many of them have accumulated.
//
// Desired contract pinned here:
// - long-expired and just-expired rows keep `revoked_at = null` after a
//   direct sweep and after a real fresh sign-in;
// - live predecessors are still revoked and the newest session survives
//   (positive controls);
// - serialized overlapping issuance still settles newest-live (positive
//   control);
// - other users' rows and already-revoked rows (their original
//   `revoked_at` instant) are untouched;
// - expired rows still never authenticate — expiry itself is unchanged.

let seq = 0;
const row = (expiresAt: Date, userId = "42") => ({
  tokenHash: `hash-sweep-${++seq}`,
  userId,
  username: "Rick",
  avatar: null as string | null,
  member: true,
  moderator: false,
  expiresAt,
});

describe("fresh-login sweep scope (memory store)", () => {
  // The memory store exposes no revoked_at, so "the sweep did not revoke
  // this expired row" is observed through the injected clock: let a row
  // expire, run the sweep, then move the clock back inside the row's
  // original lifetime. A merely-expired row reads live again; a row the
  // sweep revoked (or deleted as if revoked) stays dead. The expired row
  // is never read while expired, so lazy expiry-on-read cannot mask this.
  it("leaves expired rows un-revoked while revoking live predecessors", async () => {
    const T = 1_000_000;
    let now = T;
    const store = createMemorySessionStore(() => now);
    const expiredLongAgo = row(new Date(T + 1_000));
    const expiredJustNow = row(new Date(T + 4_999));
    const livePredecessor = row(new Date(T + 100_000));
    const newest = row(new Date(T + 100_000));
    for (const s of [expiredLongAgo, expiredJustNow, livePredecessor, newest])
      await store.create(s);

    now = T + 5_000; // both expired rows are past expiry; the rest are live
    await store.revokeUserSessions("42", newest.tokenHash);

    expect(await store.get(livePredecessor.tokenHash)).toBeNull();
    expect(await store.get(newest.tokenHash)).not.toBeNull();

    now = T + 500; // back inside every row's original lifetime
    expect(await store.get(expiredLongAgo.tokenHash)).not.toBeNull();
    expect(await store.get(expiredJustNow.tokenHash)).not.toBeNull();
    // The live predecessor stays revoked at any clock reading.
    expect(await store.get(livePredecessor.tokenHash)).toBeNull();
  });

  it("treats a row expiring exactly now as expired, not sweepable", async () => {
    const T = 2_000_000;
    let now = T;
    const store = createMemorySessionStore(() => now);
    const boundary = row(new Date(T + 1_000));
    const barelyLive = row(new Date(T + 1_001));
    const newest = row(new Date(T + 100_000));
    for (const s of [boundary, barelyLive, newest]) await store.create(s);

    now = T + 1_000; // boundary.expiresAt == now; barelyLive has 1 ms left
    await store.revokeUserSessions("42", newest.tokenHash);

    now = T + 999; // inside both rows' lifetimes again
    expect(await store.get(boundary.tokenHash)).not.toBeNull();
    expect(await store.get(barelyLive.tokenHash)).toBeNull();
  });

  it("control: revokes every live predecessor, keeps newest and other users live", async () => {
    const store = createMemorySessionStore();
    const live = new Date(Date.now() + 3_600_000);
    const first = row(live);
    const second = row(live);
    const newest = row(live);
    const otherUser = row(live, "43");
    for (const s of [first, second, newest, otherUser]) await store.create(s);

    await store.revokeUserSessions("42", newest.tokenHash);

    expect(await store.get(first.tokenHash)).toBeNull();
    expect(await store.get(second.tokenHash)).toBeNull();
    expect(await store.get(newest.tokenHash)).not.toBeNull();
    expect(await store.get(otherUser.tokenHash)).not.toBeNull();
  });
});

// --- Postgres + real sign-in route -----------------------------------------

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

/** Hold the first overlapping sign-in at its sweep until the second inserts. */
function latchedStore(inner: SessionStore) {
  const latch = newLatch();
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

// Disposable, guarded test database only (isolated fixture schema); the
// suite skips without DATABASE_URL and never touches production/staging.
const url = process.env.DATABASE_URL;
describe.skipIf(!url)("fresh-login sweep scope (Postgres)", () => {
  let fixture: JobsFixture | undefined;
  let sql: Sql;
  beforeAll(async () => {
    fixture = await createJobsFixture(url!, { max: 4 });
    sql = fixture.client as unknown as Sql;
    await migrate(sql);
  });
  afterAll(async () => fixture?.dispose());
  afterEach(async () => {
    vi.unstubAllGlobals();
    await sql`delete from web_sessions`;
  });

  const revokedAtByHash = async () => {
    const rows = await sql<{ token_hash: string; revoked_at: Date | null }[]>`
      select token_hash, revoked_at from web_sessions`;
    return new Map(rows.map((r) => [r.token_hash, r.revoked_at]));
  };

  it("revokes only the live predecessor among one live and many expired rows", async () => {
    const store = createPostgresSessionStore(sql);
    const now = Date.now();
    const expired = [
      row(new Date(now - 30 * 86_400_000)),
      row(new Date(now - 86_400_000)),
      row(new Date(now - 1_000)),
    ];
    const livePredecessor = row(new Date(now + 3_600_000));
    const newest = row(new Date(now + 3_600_000));
    for (const s of [...expired, livePredecessor, newest]) await store.create(s);
    for (const s of expired) expect(await store.get(s.tokenHash)).toBeNull();

    await store.revokeUserSessions("42", newest.tokenHash);

    const revokedAt = await revokedAtByHash();
    expect(revokedAt.get(livePredecessor.tokenHash)).not.toBeNull();
    expect(revokedAt.get(newest.tokenHash)).toBeNull();
    for (const s of expired) expect(revokedAt.get(s.tokenHash)).toBeNull();
    expect(await store.get(livePredecessor.tokenHash)).toBeNull();
    expect(await store.get(newest.tokenHash)).not.toBeNull();
    // Expiry still applies on its own: untouched expired rows never read live.
    for (const s of expired) expect(await store.get(s.tokenHash)).toBeNull();
  });

  it("control: other users and already-revoked rows keep their exact state", async () => {
    const store = createPostgresSessionStore(sql);
    const now = Date.now();
    const newest = row(new Date(now + 3_600_000));
    const otherLive = row(new Date(now + 3_600_000), "43");
    const otherExpired = row(new Date(now - 3_600_000), "43");
    for (const s of [newest, otherLive, otherExpired]) await store.create(s);
    const revokedEarlier = new Date(now - 7_200_000);
    await sql`insert into web_sessions
        (token_hash, user_id, username, member, moderator, expires_at, revoked_at)
      values
        ('hash-sweep-revoked-live', '42', 'Rick', true, false,
         ${new Date(now + 3_600_000)}, ${revokedEarlier}),
        ('hash-sweep-revoked-expired', '42', 'Rick', true, false,
         ${new Date(now - 3_600_000)}, ${revokedEarlier})`;

    await store.revokeUserSessions("42", newest.tokenHash);

    const revokedAt = await revokedAtByHash();
    expect(revokedAt.get(otherLive.tokenHash)).toBeNull();
    expect(revokedAt.get(otherExpired.tokenHash)).toBeNull();
    expect(revokedAt.get("hash-sweep-revoked-live")?.getTime()).toBe(revokedEarlier.getTime());
    expect(revokedAt.get("hash-sweep-revoked-expired")?.getTime()).toBe(revokedEarlier.getTime());
    expect(await store.get(otherLive.tokenHash)).not.toBeNull();
  });

  it("a real fresh sign-in leaves expired rows with revoked_at null", async () => {
    const store = createPostgresSessionStore(sql);
    const now = Date.now();
    const expired = [row(new Date(now - 30 * 86_400_000)), row(new Date(now - 60_000))];
    const livePredecessor = row(new Date(now + 3_600_000));
    for (const s of [...expired, livePredecessor]) await store.create(s);

    const e = { ...baseEnv, SESSION_STORE: store } as Env;
    mockDiscord();
    const res = await (await startJourney(e, "42"))();
    expect(res.status).toBe(302);

    const revokedAt = await revokedAtByHash();
    expect(revokedAt.get(livePredecessor.tokenHash)).not.toBeNull();
    for (const s of expired) expect(revokedAt.get(s.tokenHash)).toBeNull();
    expect(await store.get(livePredecessor.tokenHash)).toBeNull();
    expect(await store.get(await hashToken(bearerOf(res)))).not.toBeNull();
    expect(await statusOf(e, res)).toEqual({ authenticated: true });
  });

  it("control: serialized overlapping issuance still settles newest-live", async () => {
    const inner = createPostgresSessionStore(sql);
    const livePredecessor = row(new Date(Date.now() + 3_600_000));
    await inner.create(livePredecessor);

    const { store, latch } = latchedStore(inner);
    const e = { ...baseEnv, SESSION_STORE: store } as Env;
    mockDiscord();
    const callbackA = await startJourney(e, "42");
    const callbackB = await startJourney(e, "42");

    latch.armed = true;
    const pendingA = callbackA();
    await latch.untilInserts(1);
    const pendingB = callbackB();
    const [resA, resB] = await Promise.all([pendingA, pendingB]);
    latch.armed = false;

    expect(resA.status).toBe(302);
    expect(resB.status).toBe(302);
    const hashA = await hashToken(bearerOf(resA));
    const hashB = await hashToken(bearerOf(resB));
    expect(hashA).not.toBe(hashB);
    expect(await inner.get(hashA)).toBeNull();
    expect(await inner.get(hashB)).not.toBeNull();
    expect(await inner.get(livePredecessor.tokenHash)).toBeNull();
    expect(await statusOf(e, resA)).toEqual({ authenticated: false });
    expect(await statusOf(e, resB)).toEqual({ authenticated: true });

    const revokedAt = await revokedAtByHash();
    expect(revokedAt.get(livePredecessor.tokenHash)).not.toBeNull();
    expect(revokedAt.get(hashB)).toBeNull();
  });
});
