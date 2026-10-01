// route-inventory: POST /events
// route-inventory: PATCH /events/:key
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};
const invalidBodies = [
  ["malformed JSON", '{"title":'],
  ["empty JSON", ""],
  ["null", "null"],
  ["empty array", "[]"],
  ["array of objects", '[{"title":"Changed"}]'],
  ["string", '"Changed"'],
  ["number", "42"],
  ["boolean", "true"],
] as const;

describe.skipIf(!process.env.DATABASE_URL)("event mutation admission (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  const sent: SyncMessage[] = [];
  let env: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = {
      ...baseEnv,
      ADMIN_DB: fixture.db,
      SESSION_STORE: store,
      EVENT_SYNC_QUEUE: { send: async (message: SyncMessage) => void sent.push(message) },
    } as unknown as Env;
  });
  afterAll(async () => { await fixture?.dispose(); });

  beforeEach(async () => {
    await fixture.reset();
    sent.length = 0;
    // Second occurrence of London's autumn fold; retain seconds as well as the instant.
    await fixture.db.insert(events).values({
      eventKey: EVENT_KEY, title: "Game night", game: "Chess", description: "Bring a board",
      startsAt: new Date("2026-10-25T01:30:17Z"), endsAt: new Date("2026-10-25T01:50:29Z"),
      timezone: "Europe/London", location: "Voice", capacity: 8, status: "published",
      discordEventId: "123456789012345678", createdBy: "event-moderator", rsvpOpen: false,
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await fixture.db.insert(activityLog).values({
      description: "created event Game night", subjectType: "Event", subjectId: EVENT_KEY,
      causerId: "event-moderator",
    });
  });

  async function cookieFor(moderator = true) {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId: "event-moderator", username: "Moderator",
      avatar: null, member: true, moderator, expiresAt: new Date(Date.now() + 3600_000),
    });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
  }

  async function write(method: "POST" | "PATCH", body: string, contentType = "application/json") {
    return app.request(method === "POST" ? "/events" : `/events/${EVENT_KEY}`, {
      method, headers: { cookie: await cookieFor(), origin: APP_URL, "content-type": contentType }, body,
    }, env);
  }
  const patch = (body: unknown) => write("PATCH", JSON.stringify(body));
  const snapshot = async () => ({
    events: await fixture.db.select().from(events),
    audit: await fixture.db.select().from(activityLog),
    rsvps: await fixture.db.select().from(rsvps),
  });
  async function expectUnchanged(before: Awaited<ReturnType<typeof snapshot>>) {
    expect(await snapshot()).toEqual(before);
    expect(sent).toEqual([]);
  }

  for (const method of ["POST", "PATCH"] as const) {
    it.each(invalidBodies)(`${method} rejects %s without event, audit, or sync writes`, async (_, body) => {
      const before = await snapshot();
      const res = await write(method, body);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid", fields: { body: "Send a JSON object." } });
      await expectUnchanged(before);
    });
  }

  it("rejects a malformed mixed-case JSON media type rather than accepting an empty edit", async () => {
    const before = await snapshot();
    const res = await write("PATCH", '{"title":', "Application/Json; charset=utf-8");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", fields: { body: "Send a JSON object." } });
    await expectUnchanged(before);
  });

  it.each([
    {},
    { starts_at: "2026-10-25 01:30" },
    { ends_at: "2026-10-25 01:50" },
    { starts_at: "2026-10-25 01:30", ends_at: "2026-10-25 01:50" },
  ])("returns the timezone field error with date patch %j and no writes", async (dates) => {
    const before = await snapshot();
    const res = await patch({ timezone: "Not/AZone", ...dates });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", fields: { timezone: "Unknown timezone: Not/AZone." } });
    await expectUnchanged(before);
  });

  it("a title-only PATCH preserves omitted fields and the second fold occurrence", async () => {
    const before = await snapshot();
    const res = await patch({ title: "Renamed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      title: "Renamed", starts_at: "2026-10-25T01:30:17.000Z", ends_at: "2026-10-25T01:50:29.000Z",
      timezone: "Europe/London", capacity: 8, rsvp_open: false,
    } });
    const after = await snapshot();
    expect(after.events[0]).toEqual({ ...before.events[0], title: "Renamed", updatedAt: after.events[0]!.updatedAt, icsSequence: after.events[0]!.icsSequence });
    expect(after.events[0]!.icsSequence).toBeGreaterThan(before.events[0]!.icsSequence);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventKey: EVENT_KEY, action: "event.upsert" });
  });

  it("an empty object is a valid partial PATCH and preserves all omitted values", async () => {
    const before = await snapshot();
    const res = await patch({});
    expect(res.status).toBe(200);
    const after = await snapshot();
    expect(after.events[0]).toEqual({ ...before.events[0], updatedAt: after.events[0]!.updatedAt, icsSequence: after.events[0]!.icsSequence });
    expect(after.events[0]!.icsSequence).toBeGreaterThan(before.events[0]!.icsSequence);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.audit.at(-1)!.properties).toEqual({ updatedAt: {
      before: before.events[0]!.updatedAt.toISOString(), after: after.events[0]!.updatedAt.toISOString(),
    } });
    expect(sent).toHaveLength(1);
  });

  it.each([" Europe/London ", "", "   "])("zone %j uses the same normalization/default as form validation", async (timezone) => {
    const res = await patch({ timezone });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      timezone: "Europe/London", starts_at: "2026-10-25T01:30:17.000Z", ends_at: "2026-10-25T01:50:29.000Z",
    } });
  });

  it("a timezone-only PATCH changes the display zone, not the stored instants", async () => {
    const before = await snapshot();
    const res = await patch({ timezone: "America/New_York" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      timezone: "America/New_York", starts_at: "2026-10-25T01:30:17.000Z", ends_at: "2026-10-25T01:50:29.000Z",
    } });
    const after = await snapshot();
    expect(after.events[0]).toEqual({ ...before.events[0], timezone: "America/New_York", updatedAt: after.events[0]!.updatedAt, icsSequence: after.events[0]!.icsSequence });
    expect(after.events[0]!.icsSequence).toBeGreaterThan(before.events[0]!.icsSequence);
    expect(sent).toHaveLength(1);
  });

  it("changed fold wall time resolves to the first occurrence while an omitted end retains its instant", async () => {
    const res = await patch({ starts_at: "2026-10-25 01:45" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      starts_at: "2026-10-25T00:45:00.000Z", ends_at: "2026-10-25T01:50:29.000Z",
    } });
    expect(sent).toHaveLength(1);
  });

  it("a spring-forward gap returns the start-input wall-time error without writes", async () => {
    const before = await snapshot();
    const res = await patch({ starts_at: "2027-03-28 01:30", ends_at: "2027-03-28 03:30" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", fields: {
      starts_at: "That time never occurred in Europe/London — clocks skipped forward over it. Pick a time outside the gap.",
    } });
    await expectUnchanged(before);
  });

  it("valid spring-transition wall times still resolve with the host-zone DST offsets", async () => {
    const res = await patch({ starts_at: "2027-03-28 00:30", ends_at: "2027-03-28 02:30" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      starts_at: "2027-03-28T00:30:00.000Z", ends_at: "2027-03-28T01:30:00.000Z",
    } });
    expect(sent).toHaveLength(1);
  });

  it("form partial edits keep working", async () => {
    const res = await write("PATCH", "title=Form+edit", "application/x-www-form-urlencoded");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      title: "Form edit", starts_at: "2026-10-25T01:30:17.000Z", ends_at: "2026-10-25T01:50:29.000Z",
    } });
  });

  it("malformed input does not precede the existing moderator permission check", async () => {
    const before = await snapshot();
    const res = await app.request(`/events/${EVENT_KEY}`, {
      method: "PATCH", headers: { cookie: await cookieFor(false), origin: APP_URL, "content-type": "application/json" },
      body: '{"title":',
    }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    await expectUnchanged(before);
  });
});
