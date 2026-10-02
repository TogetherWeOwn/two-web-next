// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// JSON-route schedule validation + real-SQL null ends_at rejection (TOG-11667).
// Ports EventScheduleTest.php:16-26 (NOT NULL proof) and :29-55 (JSON-route
// missing/end-not-after-start field validation). The admin-form halves are
// proved in test/admin-event-form-errors.test.ts:103-131 and are not re-asserted here.
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
// November in Europe/London is GMT, so wall text and UTC coincide exactly.
const STARTS_ISO = "2026-11-04T20:00:00.000Z";
const ENDS_ISO = "2026-11-04T22:00:00.000Z";
const SCHEDULE = {
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "Europe/London",
};
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

describe.skipIf(!process.env.DATABASE_URL)("event JSON schedule validation (agent-testdb)", () => {
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
      userId: "json-schedule-mod",
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
  const stored = async () =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, EVENT_KEY)))[0];

  it("POST without ends_at is a 422 field error with no row", async () => {
    const before = await snapshot();
    const res = await post({
      title: "JSON schedule proof",
      starts_at: SCHEDULE.starts_at,
      timezone: SCHEDULE.timezone,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { ends_at: "When does it end?" },
    });
    await expectUnchanged(before);
  });

  it.each([
    ["before the start", "2026-11-04 19:00"],
    ["equal to the start", "2026-11-04 20:00"],
  ])("POST with the end %s is a 422 field error with no row", async (_, ends_at) => {
    const before = await snapshot();
    const res = await post({
      title: "JSON schedule proof",
      starts_at: SCHEDULE.starts_at,
      ends_at,
      timezone: SCHEDULE.timezone,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { ends_at: "The end is after the start." },
    });
    await expectUnchanged(before);
  });

  it("PATCH with the end not after the start is a 422 field error with no write", async () => {
    const before = await snapshot();
    const res = await patch(EVENT_KEY, {
      starts_at: SCHEDULE.starts_at,
      ends_at: "2026-11-04 19:00",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { ends_at: "The end is after the start." },
    });
    await expectUnchanged(before);
  });

  it("PATCH moving only the end before the stored start is refused without writes", async () => {
    const before = await snapshot();
    const res = await patch(EVENT_KEY, { ends_at: "2026-11-04 19:00" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { ends_at: "The end is after the start." },
    });
    await expectUnchanged(before);
    expect((await stored())?.endsAt.toISOString()).toBe(ENDS_ISO);
  });

  it("real SQL rejects a null ends_at with the NOT NULL constraint", async () => {
    const before = await fixture.db.select().from(events);
    let caught: unknown;
    try {
      await fixture.client.unsafe(
        `INSERT INTO events (event_key, title, starts_at, ends_at) VALUES ('01JNULLENDS00000000000000', 'Null end', '2026-11-04T20:00:00Z', NULL)`,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "23502" });
    expect(String((caught as { message?: unknown })?.message ?? caught)).toContain("ends_at");
    expect(await fixture.db.select().from(events)).toEqual(before);
  });

  it("PATCH omitting both wall times keeps the stored schedule", async () => {
    const res = await patch(EVENT_KEY, { title: "Renamed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { title: "Renamed", starts_at: STARTS_ISO, ends_at: ENDS_ISO },
    });
    const row = await stored();
    expect(row?.startsAt.toISOString()).toBe(STARTS_ISO);
    expect(row?.endsAt.toISOString()).toBe(ENDS_ISO);
  });
});
