// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// Acceptance: RSVP advisory-lock waits fail bounded with the limited verdict.
//
// `writeRsvp` and `withdrawRsvp` open their transaction with a blocking
// `pg_advisory_xact_lock(hashtext('rsvp-write:<userId>'))`, and the budget
// charge inside the same transaction re-takes the identical key. While
// another connection holds that exact advisory lock, a write or withdraw for
// the held member must settle — while the holder remains locked — with the
// existing limited verdict instead of waiting for the holder:
//
//   writeRsvp    -> { ok: false, reason: "limited", retryAfter: 1 }
//   withdrawRsvp -> { limited: true, retryAfter: 1 }
//   routes       -> the shared 429 (never a 500, never a thrown lock error)
//
// A busy pass is free and changes nothing: it charges no throttle hit,
// creates no RSVP row, and deletes no RSVP row. Contention on a member's own
// lock is that member's own parallel burst, which is exactly what the shared
// budget exists to refuse — the same busy mapping as the web-throttle
// admission lock in test/web-throttle-lock-busy.test.ts (lock-timeout 55P03
// -> limited, retryAfter 1, no hit). The routes call the service with no
// lock-error catch of their own, so the mapping must live inside
// writeRsvp/withdrawRsvp: a lock-timeout error must never propagate.
//
// The bound's mechanism and exact value are not pinned — any lock_timeout
// that resolves well inside the 8s race bound passes (the codebase already
// carries 2s and 5s precedents); an unbounded wait does not. Note the other
// side is pinned elsewhere: test/rsvp-throttle-prune-batch.test.ts holds
// this same member lock for ~3.2s and expects the queued write to then be
// judged on expiry, so a timeout below that window must reconcile those
// suites rather than silently flip them to limited.
//
// Scope: only the advisory lock is contended here. Event/RSVP row locks keep
// their current wait-then-judge semantics (pinned by test/rsvp.test.ts);
// whether a transaction-wide lock_timeout also bounds them is the Builder's
// documented choice, provided those suites stay green and no lock timeout
// can surface as a 500.
//
// Lock acquisition is coordinated explicitly: the holder's advisory-lock
// query resolving inside its open transaction on a second connection is the
// handshake that the lock is held; the measured call races an 8s bound only
// so an unbounded wait fails fast instead of hanging the suite. Every busy
// assertion runs while the holder remains locked: releasing first could let
// a hung request complete and mask it.
//
// Live against the guarded test database in a throwaway schema. Skipped
// when DATABASE_URL is unset. Never point this at production or staging.
import { serializeSigned } from "hono/utils/cookie";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { withdrawRsvp, writeRsvp, type RsvpWriteResult } from "../src/events/rsvp";
import type { QueueMessage } from "../src/jobs/types";

// RSVP route tests isolate dispatch; other suites prove the real producer.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { RSVP_RATE_LIMIT } from "../src/islands/contracts";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const BUSY_BOUND_MS = 8000;
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
// Well-formed key no seeded event ever uses.
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

async function cookieFor(store: SessionStore, userId: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
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

describe("rsvp lock-busy test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("rsvp advisory-lock waits are busy-bounded (test database)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let client: MemberDataFixture["client"];
  const store = createMemorySessionStore();
  const sent: QueueMessage[] = [];
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    get ADMIN_DB() {
      return db;
    },
    SESSION_STORE: store,
    SYNC_EVENT_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) },
  } as unknown as Env;

  beforeAll(async () => {
    // Pool width: the measured transaction, the assertion queries and the
    // pg_stat_activity observer each need their own connection while a
    // separate holder pool keeps the advisory lock.
    fixture = await createMemberDataFixture(raw!, { max: 8 });
    db = fixture.db;
    client = fixture.client;
  });
  beforeEach(async () => {
    await fixture.reset();
    await client`delete from web_throttle_hits`;
    sent.length = 0;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const put = async (key: string, as: string, status: string = "going") =>
    app.request(
      `/events/${key}/rsvp`,
      {
        method: "PUT",
        headers: {
          cookie: await cookieFor(store, as),
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status }),
      },
      env,
    );

  const hits = async (userId: string): Promise<number> => {
    const [{ n }] =
      (await client`select count(*)::int as n from web_throttle_hits where bucket = ${`rsvp-write:${userId}`}`) as unknown as [
        { n: number },
      ];
    return n;
  };
  const rowsFor = (eventId: number, userId: string) =>
    db
      .select()
      .from(rsvps)
      .where(eq(rsvps.eventId, eventId))
      .then((rows) => rows.filter((r) => r.userId === userId));

  async function seed(): Promise<{ id: number; key: string }> {
    const key = `01W9${Math.random().toString(36).slice(2, 14).toUpperCase()}`
      .padEnd(26, "0")
      .slice(0, 26)
      .replace(/[ILOU]/g, "7");
    const [row] = await db
      .insert(events)
      .values({
        eventKey: key,
        title: "Lock busy night",
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 2 * 3600_000),
        timezone: "UTC",
        location: "Voice",
        status: "published",
      })
      .returning();
    return { id: row!.id, key };
  }

  // Hold `rsvp-write:<userId>` on a second connection until the returned
  // release runs. Resolves only once the lock is actually held.
  async function holdMemberLock(userId: string) {
    const url = testDatabaseUrl(raw!);
    const holder = postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    await holder.unsafe("BEGIN");
    await holder`select pg_advisory_xact_lock(hashtext(${"rsvp-write:" + userId}))`;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await holder.unsafe("ROLLBACK");
      await holder.end({ timeout: 1 });
    };
  }

  // Race the measured call against a generous bound. The bound is not the
  // proof — the lock handshake is — it only turns an unbounded wait into a
  // readable failure instead of a hung suite.
  async function settleWithinBound<T>(pending: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `rsvp advisory-lock wait was not bounded: ${what} still blocked ` +
                    `after ${BUSY_BOUND_MS}ms while the advisory lock holder remains locked`,
                ),
              ),
            BUSY_BOUND_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it("control: an uncontended write lands byte-identical and charges exactly one hit", async () => {
    const ev = await seed();
    const user = "busy-control-write";
    expect(await writeRsvp(db, ev.key, user, "going")).toEqual({
      ok: true,
      created: true,
      answer: { status: "going", syncedToDiscordAt: null, waitlistPosition: null },
      mirrored: "published",
      eventKey: ev.key,
    });
    expect(await hits(user)).toBe(1);
    expect(await rowsFor(ev.id, user)).toHaveLength(1);
  });

  it("control: an uncontended withdraw deletes byte-identical and charges exactly one hit", async () => {
    const ev = await seed();
    const user = "busy-control-withdraw";
    expect((await writeRsvp(db, ev.key, user, "going")).ok).toBe(true);
    await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${user}`}`;
    expect(await withdrawRsvp(db, ev.key, user)).toEqual({
      limited: false,
      deleted: true,
      status: "published",
    });
    expect(await hits(user)).toBe(1);
    expect(await rowsFor(ev.id, user)).toHaveLength(0);
  });

  it("control: an uncontended unknown-key write is still not_found and spends nothing", async () => {
    const user = "busy-control-unknown";
    expect(await writeRsvp(db, UNKNOWN_KEY, user, "going")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await hits(user)).toBe(0);
  });

  it("control: an uncontended over-budget write refuses with the window Retry-After and charges nothing", async () => {
    const ev = await seed();
    const user = "busy-control-over-budget";
    await client`insert into web_throttle_hits (bucket, at)
      select ${`rsvp-write:${user}`}, clock_timestamp()
      from generate_series(1, ${RSVP_RATE_LIMIT.maxAttempts})`;
    const refused = await writeRsvp(db, ev.key, user, "going");
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.reason === "limited") {
      expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfter).toBeLessThanOrEqual(RSVP_RATE_LIMIT.decaySeconds);
    } else {
      expect.unreachable("over-budget write must refuse as limited");
    }
    expect(await hits(user)).toBe(RSVP_RATE_LIMIT.maxAttempts);
    expect(await rowsFor(ev.id, user)).toHaveLength(0);
  });

  it("control: an independent member writes while another member's lock is held", async () => {
    const ev = await seed();
    const held = "busy-control-held-member";
    const free = "busy-control-free-member";
    const release = await holdMemberLock(held);
    try {
      const start = Date.now();
      const result = await settleWithinBound(
        writeRsvp(db, ev.key, free, "going"),
        `writeRsvp for independent member ${free}`,
      );
      expect(Date.now() - start).toBeLessThan(BUSY_BOUND_MS);
      expect(result.ok).toBe(true);
      expect(await hits(free)).toBe(1);
      expect(await hits(held)).toBe(0);
      expect(await rowsFor(ev.id, free)).toHaveLength(1);
    } finally {
      await release();
    }
  });

  it("control: a write queued behind the member lock succeeds once the holder releases", async () => {
    const ev = await seed();
    const user = "busy-control-queued";
    const release = await holdMemberLock(user);
    let pending: Promise<RsvpWriteResult> | undefined;
    try {
      pending = writeRsvp(db, ev.key, user, "going");
      // Explicit coordination: wait until a backend is actually queued on an
      // advisory lock before releasing, so this control proves the queued
      // path (wait, then judge normally) rather than a race past the holder.
      await expect
        .poll(
          async () => {
            const [{ n }] = (await client`select count(*)::int as n from pg_stat_activity
                where wait_event_type = 'Lock' and wait_event = 'advisory'`) as unknown as [
              { n: number },
            ];
            return n;
          },
          { timeout: 4000, interval: 25 },
        )
        .toBeGreaterThanOrEqual(1);
    } finally {
      await release();
    }
    const result = await settleWithinBound(pending!, `queued writeRsvp for ${user}`);
    expect(result).toEqual({
      ok: true,
      created: true,
      answer: { status: "going", syncedToDiscordAt: null, waitlistPosition: null },
      mirrored: "published",
      eventKey: ev.key,
    });
    expect(await hits(user)).toBe(1);
    expect(await rowsFor(ev.id, user)).toHaveLength(1);
  });

  it("writeRsvp refuses limited within the bound while the member lock is held", async () => {
    const ev = await seed();
    const user = "busy-write";
    const release = await holdMemberLock(user);
    let pending: Promise<RsvpWriteResult> | undefined;
    try {
      const start = Date.now();
      pending = writeRsvp(db, ev.key, user, "going");
      const busy = await settleWithinBound(pending, `writeRsvp for ${user}`);
      const elapsed = Date.now() - start;

      // Every assertion below runs while the holder remains locked.
      expect(elapsed).toBeLessThan(BUSY_BOUND_MS);
      // The existing limited verdict: never an admission, never a thrown
      // lock error.
      expect(busy).toEqual({ ok: false, reason: "limited", retryAfter: 1 });
      // The busy pass is free and writes nothing.
      expect(await hits(user)).toBe(0);
      expect(await rowsFor(ev.id, user)).toHaveLength(0);
    } finally {
      await release();
      // Let a still-blocked call settle after release so no work dangles
      // into the next test (on the unbounded path it now completes and
      // writes; beforeEach clears it).
      await pending?.catch(() => null);
    }

    // After release, normal admission resumes. Discard any row/hit a
    // still-blocked call landed once released (the unbounded path); the
    // assertions below measure only post-busy behaviour once fixed.
    await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${user}`}`;
    await db.delete(rsvps).where(eq(rsvps.eventId, ev.id));
    expect((await writeRsvp(db, ev.key, user, "going")).ok).toBe(true);
    expect(await hits(user)).toBe(1);
  });

  it("withdrawRsvp refuses limited within the bound while the member lock is held", async () => {
    const ev = await seed();
    const user = "busy-withdraw";
    expect((await writeRsvp(db, ev.key, user, "going")).ok).toBe(true);
    await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${user}`}`;

    const release = await holdMemberLock(user);
    let pending: ReturnType<typeof withdrawRsvp> | undefined;
    try {
      const start = Date.now();
      pending = withdrawRsvp(db, ev.key, user);
      const busy = await settleWithinBound(pending, `withdrawRsvp for ${user}`);
      const elapsed = Date.now() - start;

      // Every assertion below runs while the holder remains locked.
      expect(elapsed).toBeLessThan(BUSY_BOUND_MS);
      expect(busy).toEqual({ limited: true, retryAfter: 1 });
      // The busy pass is free and deletes nothing: the row survives.
      expect(await hits(user)).toBe(0);
      expect(await rowsFor(ev.id, user)).toHaveLength(1);
    } finally {
      await release();
      await pending?.catch(() => null);
    }

    // After release, a withdraw still works. Re-seed the row first in case a
    // still-blocked call deleted it once released (the unbounded path).
    await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${user}`}`;
    if ((await rowsFor(ev.id, user)).length === 0) {
      expect((await writeRsvp(db, ev.key, user, "going")).ok).toBe(true);
      await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${user}`}`;
    }
    expect(await withdrawRsvp(db, ev.key, user)).toEqual({
      limited: false,
      deleted: true,
      status: "published",
    });
    expect(await hits(user)).toBe(1);
  });

  it("a busy write spends no budget: the full budget is still there after release", async () => {
    const ev = await seed();
    const user = "busy-budget";
    // Fill all but one slot of the shared budget.
    await client`insert into web_throttle_hits (bucket, at)
      select ${`rsvp-write:${user}`}, clock_timestamp()
      from generate_series(1, ${RSVP_RATE_LIMIT.maxAttempts - 1})`;

    const release = await holdMemberLock(user);
    let pending: Promise<RsvpWriteResult> | undefined;
    try {
      pending = writeRsvp(db, ev.key, user, "going");
      const busy = await settleWithinBound(pending, `writeRsvp for ${user}`);
      expect(busy).toEqual({ ok: false, reason: "limited", retryAfter: 1 });
      expect(await hits(user)).toBe(RSVP_RATE_LIMIT.maxAttempts - 1);
      expect(await rowsFor(ev.id, user)).toHaveLength(0);
    } finally {
      await release();
      await pending?.catch(() => null);
    }

    // Discard any hit/row a still-blocked call landed once released (the
    // unbounded path), back to the seeded all-but-one state.
    await db.delete(rsvps).where(eq(rsvps.eventId, ev.id));
    await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${user}`}`;
    await client`insert into web_throttle_hits (bucket, at)
      select ${`rsvp-write:${user}`}, clock_timestamp()
      from generate_series(1, ${RSVP_RATE_LIMIT.maxAttempts - 1})`;
    // The one remaining slot admits exactly one write; the next refuses.
    expect((await writeRsvp(db, ev.key, user, "going")).ok).toBe(true);
    const refused = await writeRsvp(db, ev.key, user, "maybe");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("limited");
    expect(await hits(user)).toBe(RSVP_RATE_LIMIT.maxAttempts);
  });

  it("route PUT answers the shared 429 within the bound while the member lock is held, never a 500", async () => {
    const ev = await seed();
    const user = "busy-route-put";
    const release = await holdMemberLock(user);
    let pending: Promise<Response> | undefined;
    try {
      const start = Date.now();
      pending = put(ev.key, user, "going");
      const response = await settleWithinBound(pending, `PUT /events/${ev.key}/rsvp for ${user}`);
      const elapsed = Date.now() - start;

      // Every assertion below runs while the holder remains locked.
      expect(elapsed).toBeLessThan(BUSY_BOUND_MS);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await hits(user)).toBe(0);
      expect(await rowsFor(ev.id, user)).toHaveLength(0);
    } finally {
      await release();
      await pending?.catch(() => null);
    }
  });
});
