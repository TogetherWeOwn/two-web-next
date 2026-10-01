// route-inventory: POST /events
// route-inventory: PATCH /events/:key
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

// Keep the routes, tracking ledger and unique locks real, in the owned schema.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

type SyncEventMessage = Extract<QueueMessage, { kind: "sync-event" }>;

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
  let realPostgres: typeof postgres;
  const store = createMemorySessionStore();
  const sent: SyncEventMessage[] = [];
  let env: Env;

  beforeAll(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    fixture = await createMemberDataFixture(url.href);
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
      testDatabaseUrl(raw);
      return realPostgres(raw, { ...opts, port: 5432, password: () => url.password,
        connection: { search_path: fixture.schemaName }, onnotice: () => {} });
    }) as typeof postgres);
    env = {
      ...baseEnv,
      DB: { connectionString: url.href },
      ADMIN_DB: fixture.db,
      SESSION_STORE: store,
      SYNC_EVENT_QUEUE: { send: async (message) => {
        sent.push(message as SyncEventMessage);
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
      } },
    } as Env;
  });
  afterAll(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.client`delete from queue_jobs`;
    await fixture.client`delete from job_unique_locks`;
    await fixture.client`delete from web_throttle_hits`;
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
    jobs: await fixture.client`select * from queue_jobs order by job_id`,
    locks: await fixture.client`select * from job_unique_locks order by key`,
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
    expect(after.events[0]).toEqual({ ...before.events[0], title: "Renamed", updatedAt: after.events[0]!.updatedAt,
      icsSequence: after.events[0]!.icsSequence, syncRevision: after.events[0]!.syncRevision });
    expect(after.events[0]!.icsSequence).toBeGreaterThan(before.events[0]!.icsSequence);
    expect(after.events[0]!.syncRevision).toBeGreaterThan(before.events[0]!.syncRevision);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ kind: "sync-event", eventKey: EVENT_KEY,
      idempotencyKey: expect.any(String), jobId: expect.any(String),
      leaseToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]!.job_id).toBe(sent[0]!.jobId);
    expect(after.locks).toHaveLength(1);
    expect(after.locks[0]!.key).toBe(`sync-event:${EVENT_KEY}`);
    expect(after.locks[0]!.owner_token).toBe(sent[0]!.leaseToken);
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
    expect(after.events[0]).toEqual({ ...before.events[0], timezone: "America/New_York", updatedAt: after.events[0]!.updatedAt,
      icsSequence: after.events[0]!.icsSequence, syncRevision: after.events[0]!.syncRevision });
    expect(after.events[0]!.icsSequence).toBeGreaterThan(before.events[0]!.icsSequence);
    expect(after.events[0]!.syncRevision).toBeGreaterThan(before.events[0]!.syncRevision);
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
