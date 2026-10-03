// route-inventory: PUT /events/:key/rsvp
// TOG-11670: RSVP write-back outage proof. Joins the three partial seams
// (successful enqueue in test/rsvp.test.ts, enqueue-failure pin in
// test/events.test.ts, mocked retries in test/jobs.test.ts, pending/synced
// copy in test/islands-rsvp-button.test.ts) into one same-row chain: a
// failing bot transport still commits the seat with a null sync stamp and a
// pending member view, then the same row retried through the real
// handleSyncEvent stamps the event mirror + RSVP and flips the view to
// synced. Uses the tracked SYNC_EVENT_QUEUE producer (TOG-10815);
// routing (TOG-10815), commit-before-dispatch (:140) and real-mirror timing
// (:141) stay out of scope.
// Live against agent-testdb (skipped without DATABASE_URL). Never point this
// at anything but a test container.
import { serializeSigned } from "hono/utils/cookie";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { RSVP_COPY, RSVP_SYNCED_TESTID, RSVP_SYNCING_TESTID } from "../src/islands/contracts";
import { pgEventStore } from "../src/jobs/events";
import { handleSyncEvent } from "../src/jobs/sync-event";
import {
  BotTransportError,
  type BotClient,
  type EventStore,
  type QueueMessage,
} from "../src/jobs/types";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const APP_URL = "https://next.example.test";

// Member-visible sync state derives from the persisted stamp, never from the
// transport: null means "saved, syncing" (pending), a stamp means synced. A
// save failure would be a non-2xx PUT with no row, never this copy.
const memberSyncView = (syncedToDiscordAt: Date | null) =>
  syncedToDiscordAt
    ? { copy: RSVP_COPY.synced, testid: RSVP_SYNCED_TESTID }
    : { copy: RSVP_COPY.syncing, testid: RSVP_SYNCING_TESTID };

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

// Static containment pin: the guard this file wires below refuses non-test
// URLs before any driver exists. Always runs, needs no database.
describe("rsvp write-back outage containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rsvp write-back outage (agent-testdb)", () => {
  // Owned disposable schema (W15 fixture): every pool and driver below resolves
  // unqualified names inside `w15_<uuid>`, so nothing here can reach the
  // caller's tables. The guard runs before any driver exists and dispose()
  // drops the schema.
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  const store = createMemorySessionStore();
  const sent: QueueMessage[] = [];
  let jobsSql: postgres.Sql;
  const okSend = async (m: unknown) => {
    sent.push(m as QueueMessage);
    return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
  };
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
    DB: { connectionString: "" },
    SYNC_EVENT_QUEUE: { send: okSend },
  } as unknown as Env;
  // Queue-down variant: enqueue throws, so the write must still commit and the
  // reconcile pass owns the redispatch (enqueue never throws by contract).
  // Getter, not a spread value: env.ADMIN_DB is assigned in beforeAll, after
  // this object is built.
  const failingQueueEnv = {
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
    DB: { connectionString: "" },
    SYNC_EVENT_QUEUE: {
      send: async () => {
        throw new Error("queue down");
      },
    },
  } as unknown as Env;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    const realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    const options = {
      max: 2,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    };
    (env as unknown as { DB: { connectionString: string } }).DB.connectionString = url.href;
    (failingQueueEnv as unknown as { DB: { connectionString: string } }).DB.connectionString =
      url.href;
    // Producer pools go to the same disposable schema as the fixture.
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
      testDatabaseUrl(raw);
      return realPostgres(raw, { ...opts, ...options });
    }) as typeof postgres);
    jobsSql = realPostgres(url.href, options);
  });

  const call = async (
    target: typeof env,
    method: string,
    key: string,
    as: string | null,
    body?: unknown,
  ) =>
    app.request(
      `/events/${key}/rsvp`,
      {
        method,
        headers: {
          ...(as ? { cookie: await cookieFor(store, as) } : {}),
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      target,
    );
  const put = (key: string, as: string | null, status: unknown = "going") =>
    call(env, "PUT", key, as, { status });

  const HOUR = 3600_000;
  async function seed(
    over: Partial<typeof events.$inferInsert> = {},
  ): Promise<{ id: number; key: string }> {
    const key = `01WB${Math.random()
      .toString(36)
      .slice(2, 14)
      .toUpperCase()
      .replace(/[ILOU]/g, "7")}`
      .padEnd(26, "0")
      .slice(0, 26);
    const [row] = await db
      .insert(events)
      .values({
        eventKey: key,
        title: "Outage night",
        location: "Voice",
        startsAt: new Date(Date.now() + HOUR),
        endsAt: new Date(Date.now() + 2 * HOUR),
        status: "published",
        ...over,
      })
      .returning();
    return { id: row!.id, key };
  }
  const rsvpRow = async (eventId: number, userId: string) =>
    (
      await db
        .select()
        .from(rsvps)
        .where(and(eq(rsvps.eventId, eventId), eq(rsvps.userId, userId)))
    )[0] ?? null;
  const eventRow = async (key: string) =>
    (await db.select().from(events).where(eq(events.eventKey, key)))[0]!;

  const realStore = (): EventStore => pgEventStore(jobsSql);

  beforeEach(async () => {
    await fixture.client`delete from web_throttle_hits`;
    await fixture.reset();
    sent.length = 0;
  });
  afterAll(async () => {
    vi.mocked(postgres).mockReset();
    await jobsSql?.end({ timeout: 1 });
    await fixture?.dispose();
  });

  it("bot outage saves the seat as pending, recovery stamps the same row synced", async () => {
    const ev = await seed();
    let botUp = false;
    const bot = {
      upsertEvent: async () => {
        if (!botUp) throw new BotTransportError("connection refused");
        return { ok: true, requestId: null, discordEventId: "1234567890" };
      },
    } as unknown as BotClient;
    const store = realStore();

    // Phase 1 — outage: the member write still commits.
    const res = await put(ev.key, "member-1", "going");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
    });
    // The write-back was still dispatched; the outage lives consumer-side.
    expect(sent.map((m) => m.kind)).toEqual(["sync-event"]);
    const produced = sent[0] as Extract<QueueMessage, { kind: "sync-event" }>;
    expect(produced.eventKey).toBe(ev.key);

    // Seat persisted, no stamp anywhere: no false mirror.
    const saved = await rsvpRow(ev.id, "member-1");
    expect(saved).toMatchObject({ status: "going", syncedToDiscordAt: null });
    expect((await eventRow(ev.key)).discordEventId).toBeNull();

    // Phase 2 — member view while the retry is outstanding: confirmed seat,
    // pending sync, never a save failure.
    expect(memberSyncView(saved!.syncedToDiscordAt)).toEqual({
      copy: RSVP_COPY.syncing,
      testid: RSVP_SYNCING_TESTID,
    });
    expect(RSVP_COPY.syncing).toBe("Saved. Syncing to Discord.");
    const retry = await handleSyncEvent(produced, 1, {
      bot,
      events: store,
      now: () => new Date(Date.now() + 60_000),
    });
    expect(retry).toEqual({ retryInSeconds: 10 });
    expect((await rsvpRow(ev.id, "member-1"))!.syncedToDiscordAt).toBeNull();
    expect((await eventRow(ev.key)).discordEventId).toBeNull();

    // Phase 3 — recovery: the same row retried through the handler stamps the
    // event mirror and the RSVP, and the member view flips to synced.
    botUp = true;
    expect(
      await handleSyncEvent(produced, 2, {
        bot,
        events: store,
        now: () => new Date(Date.now() + 600_000),
      }),
    ).toEqual({ done: true });
    const synced = await rsvpRow(ev.id, "member-1");
    expect(synced!.id).toBe(saved!.id);
    expect(synced!.syncedToDiscordAt).not.toBeNull();
    expect((await eventRow(ev.key)).discordEventId).toBe("1234567890");
    expect(memberSyncView(synced!.syncedToDiscordAt)).toEqual({
      copy: RSVP_COPY.synced,
      testid: RSVP_SYNCED_TESTID,
    });
  });

  it("a failed enqueue still saves the seat as pending (no retry yet)", async () => {
    const ev = await seed();
    const res = await call(failingQueueEnv, "PUT", ev.key, "member-2", { status: "going" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
    });
    expect(sent).toHaveLength(0);
    const saved = await rsvpRow(ev.id, "member-2");
    expect(saved).toMatchObject({ status: "going", syncedToDiscordAt: null });
    expect((await eventRow(ev.key)).discordEventId).toBeNull();
    // Pending without any retry outstanding: still "syncing", never the save-failure copy.
    expect(memberSyncView(saved!.syncedToDiscordAt)).toEqual({
      copy: RSVP_COPY.syncing,
      testid: RSVP_SYNCING_TESTID,
    });
    expect(RSVP_COPY.failedTitle).toBe("That RSVP didn't save.");
  });
});
