// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// Event-key immutability + real-SQL uniqueness (TOG-11664).
// Ports EventKeyTest.php:31-47 (deliberate key-write refusal with
// persisted-key immutability, SQL-enforced uniqueness). The ULID-shape and
// ordinary-update halves live in test/events.test.ts and are not re-asserted here.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FORGED_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DUP_KEY = "01DUPKEY000000000000000000";
// November in Europe/London is GMT, so wall text and UTC coincide exactly.
const STARTS_ISO = "2026-11-04T20:00:00.000Z";
const ENDS_ISO = "2026-11-04T22:00:00.000Z";
const SCHEDULE = {
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "Europe/London",
};
const KEY_ERROR = "The event key is assigned when the event is created and cannot be changed.";
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

describe.skipIf(!process.env.DATABASE_URL)("event key immutability (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  const sent: QueueMessage[] = [];
  let env: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = {
      ...baseEnv,
      ADMIN_DB: fixture.db,
      SESSION_STORE: store,
      SYNC_EVENT_QUEUE: {
        send: async (message: unknown) => {
          sent.push(message as QueueMessage);
          return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
        },
      },
    } as unknown as Env;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    sent.length = 0;
    await fixture.db.insert(events).values({
      eventKey: EVENT_KEY,
      title: "Game night",
      startsAt: new Date(STARTS_ISO),
      endsAt: new Date(ENDS_ISO),
      timezone: "Europe/London",
      status: "draft",
    });
  });

  async function cookieFor(moderator = true) {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "key-immutability-mod",
      username: "Moderator",
      avatar: null,
      member: true,
      moderator,
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

  const jsonHeaders = async () => ({
    cookie: await cookieFor(),
    origin: APP_URL,
    "content-type": "application/json",
  });
  const post = (body: unknown) =>
    jsonHeaders().then((headers) =>
      app.request("/events", { method: "POST", headers, body: JSON.stringify(body) }, env),
    );
  const patch = (key: string, body: unknown) =>
    jsonHeaders().then((headers) =>
      app.request(`/events/${key}`, { method: "PATCH", headers, body: JSON.stringify(body) }, env),
    );
  const snapshot = async () => ({
    events: await fixture.db.select().from(events),
    audit: await fixture.db.select().from(activityLog),
    rsvps: await fixture.db.select().from(rsvps),
  });
  async function expectUnchanged(before: Awaited<ReturnType<typeof snapshot>>) {
    expect(await snapshot()).toEqual(before);
    expect(sent).toEqual([]);
  }
  const stored = async (key: string) =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, key)))[0];

  it.each([
    ["event_key", { event_key: FORGED_KEY }],
    ["eventKey", { eventKey: FORGED_KEY }],
  ])("POST with a forged %s is a 422 field error with no row", async (_, forged) => {
    const before = await snapshot();
    const res = await post({ title: "Forged key proof", ...SCHEDULE, ...forged });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", fields: { event_key: KEY_ERROR } });
    await expectUnchanged(before);
  });

  it.each([
    ["event_key", { event_key: FORGED_KEY }],
    ["eventKey", { eventKey: FORGED_KEY }],
  ])(
    "PATCH with a forged %s is refused and the row stays under the original key",
    async (_, forged) => {
      const before = await snapshot();
      const res = await patch(EVENT_KEY, forged);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid", fields: { event_key: KEY_ERROR } });
      await expectUnchanged(before);
      const row = await stored(EVENT_KEY);
      expect(row?.eventKey).toBe(EVENT_KEY);
      expect(row?.title).toBe("Game night");
      expect(await stored(FORGED_KEY)).toBeUndefined();
    },
  );

  it("an ordinary title PATCH still succeeds and leaves the key alone", async () => {
    const res = await patch(EVENT_KEY, { title: "Renamed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { event_key: EVENT_KEY, title: "Renamed" } });
    expect((await stored(EVENT_KEY))?.title).toBe("Renamed");
  });

  it("real SQL rejects a duplicate event_key with the unique constraint", async () => {
    const row = {
      eventKey: DUP_KEY,
      title: "First holder",
      startsAt: new Date(STARTS_ISO),
      endsAt: new Date(ENDS_ISO),
      timezone: "Europe/London",
      status: "draft",
    };
    await fixture.db.insert(events).values(row);
    const before = await fixture.db.select().from(events);
    let caught: unknown;
    try {
      await fixture.db.insert(events).values({ ...row, title: "Second holder" });
    } catch (err) {
      caught = err;
    }
    // Drizzle wraps the Postgres error: code and constraint live on .cause.
    const cause = (caught as { cause?: unknown })?.cause;
    expect(cause).toMatchObject({ code: "23505", constraint_name: "events_event_key_unique" });
    expect(await fixture.db.select().from(events)).toEqual(before);
  });
});
