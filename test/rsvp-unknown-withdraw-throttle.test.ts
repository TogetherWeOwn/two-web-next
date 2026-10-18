// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// Unknown-event withdraw must spend zero throttle budget.
//
// A withdraw against an event key that resolves to no event changes
// nothing, so it must cost nothing: repeated unknown-key DELETEs (route)
// and withdrawRsvp calls (service) return quietly, leave the member's
// shared PUT/DELETE budget counter untouched, and never 429 / limit a
// following valid PUT. The empty-string key the route falls back to for
// a forged or malformed key is bound by the same rule.
//
// Live against the disposable Postgres fixture (skipped without
// DATABASE_URL, like test/rsvp.test.ts). Never point this at anything
// but a test container. The valid-event controls at the end pin the
// other half of the contract: a real withdraw still charges, the
// budget still caps real writes, and an unknown-key PUT (already
// refusal-free) still spends nothing.
import { serializeSigned } from "hono/utils/cookie";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { withdrawRsvp, writeRsvp } from "../src/events/rsvp";
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
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
// Well-formed key no seeded event ever uses (the same stand-in the
// route suite uses for an unknown event).
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// More unknown withdraws than the whole shared budget allows real writes.
const BURST = RSVP_RATE_LIMIT.maxAttempts + 3;

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

describe.skipIf(!process.env.DATABASE_URL)("unknown-event withdraw throttle (agent-testdb)", () => {
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
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
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

  // Sessions rotate on each authenticated view, so every request mints a
  // fresh cookie, as in test/rsvp.test.ts.
  const call = async (method: string, key: string, as: string, body?: unknown) =>
    app.request(
      `/events/${key}/rsvp`,
      {
        method,
        headers: {
          cookie: await cookieFor(store, as),
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const put = (key: string, as: string, status: string = "going") =>
    call("PUT", key, as, { status });

  const hits = async (userId: string): Promise<number> => {
    const [{ n }] =
      (await client`select count(*)::int as n from web_throttle_hits where bucket = ${`rsvp-write:${userId}`}`) as unknown as [
        { n: number },
      ];
    return n;
  };
  const rows = (eventId: number) => db.select().from(rsvps).where(eq(rsvps.eventId, eventId));

  async function seed(): Promise<{ id: number; key: string }> {
    const key = `01W9${Math.random().toString(36).slice(2, 14).toUpperCase()}`
      .padEnd(26, "0")
      .slice(0, 26)
      .replace(/[ILOU]/g, "7");
    const [row] = await db
      .insert(events)
      .values({
        eventKey: key,
        title: "Unknown withdraw night",
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 2 * 3600_000),
        timezone: "UTC",
        location: "Voice",
        status: "published",
      })
      .returning();
    return { id: row!.id, key };
  }

  it("service: an unknown-key withdraw burst spends zero budget and the next valid PUT lands", async () => {
    const user = "unknown-burst";
    for (let i = 0; i < BURST; i++) {
      const result = await withdrawRsvp(db, UNKNOWN_KEY, user);
      expect(result.limited, `unknown withdraw #${i + 1}`).toBe(false);
    }
    expect(await hits(user)).toBe(0);

    const ev = await seed();
    const written = await writeRsvp(db, ev.key, user, "going");
    expect(written.ok).toBe(true);
    expect((await rows(ev.id)).map((r) => r.userId)).toEqual([user]);
    // Exactly one spent hit: the real write, none of the burst.
    expect(await hits(user)).toBe(1);
  });

  it("service: the empty-string fallback key spends zero budget over a burst", async () => {
    const user = "forged-empty";
    for (let i = 0; i < BURST; i++) {
      const result = await withdrawRsvp(db, "", user);
      expect(result.limited, `empty-key withdraw #${i + 1}`).toBe(false);
    }
    expect(await hits(user)).toBe(0);

    const ev = await seed();
    const written = await writeRsvp(db, ev.key, user, "going");
    expect(written.ok).toBe(true);
    expect(await hits(user)).toBe(1);
  });

  it("route: unknown-key DELETEs stay 204 past the whole budget and the next valid PUT is never 429", async () => {
    const user = "route-unknown-burst";
    for (let i = 0; i < BURST; i++) {
      const res = await call("DELETE", UNKNOWN_KEY, user);
      expect(res.status, `unknown DELETE #${i + 1}`).toBe(204);
    }
    expect(await hits(user)).toBe(0);

    const ev = await seed();
    expect((await put(ev.key, user)).status).toBe(201);
    expect((await rows(ev.id)).map((r) => r.userId)).toEqual([user]);
    expect(await hits(user)).toBe(1);
  });

  it("route: a forged malformed key DELETE burst stays 204 and spends nothing", async () => {
    const user = "route-forged-burst";
    for (let i = 0; i < BURST; i++) {
      const res = await call("DELETE", "not-a-key", user);
      expect(res.status, `forged DELETE #${i + 1}`).toBe(204);
    }
    expect(await hits(user)).toBe(0);

    const ev = await seed();
    expect((await put(ev.key, user)).status).toBe(201);
    expect(await hits(user)).toBe(1);
  });

  it("control: withdrawing from a real event still charges the shared budget", async () => {
    const user = "valid-withdraw";
    const ev = await seed();
    expect((await writeRsvp(db, ev.key, user, "going")).ok).toBe(true);
    expect(await hits(user)).toBe(1);

    const result = await withdrawRsvp(db, ev.key, user);
    expect(result.limited).toBe(false);
    expect(await rows(ev.id)).toHaveLength(0);
    expect(await hits(user)).toBe(2);
  });

  it("control: the budget still caps real writes after twelve spends", async () => {
    const user = "valid-budget";
    const ev = await seed();
    for (let i = 0; i < RSVP_RATE_LIMIT.maxAttempts; i++) {
      const written = await writeRsvp(db, ev.key, user, i % 2 ? "maybe" : "going");
      expect(written.ok, `valid write #${i + 1}`).toBe(true);
    }
    expect(await hits(user)).toBe(RSVP_RATE_LIMIT.maxAttempts);

    const over = await writeRsvp(db, ev.key, user, "going");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("limited");
    // A real withdraw at the cap is limited too; refusals spend nothing.
    expect((await withdrawRsvp(db, ev.key, user)).limited).toBe(true);
    expect(await hits(user)).toBe(RSVP_RATE_LIMIT.maxAttempts);
  });

  it("control: an unknown-key PUT spends nothing (the parity the DELETE must match)", async () => {
    const user = "unknown-put";
    const written = await writeRsvp(db, UNKNOWN_KEY, user, "going");
    expect(written.ok).toBe(false);
    expect(await hits(user)).toBe(0);
  });
});
