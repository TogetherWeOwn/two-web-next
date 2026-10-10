// Admin branch-floor behavior pins: validation rejections, store failure and
// rollback paths, error/empty page states, guard denials, and route/query edge
// cases. Every test asserts an observable outcome (HTTP status, body text, or
// persisted rows) — never call counts or private structure.
//
// Live suites use an owned synthetic schema on approved disposable Postgres and
// skip without DATABASE_URL, like test/admin.test.ts. Pure render/guard/parser
// suites run everywhere with no database.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStoreForTests } from "../src/admin/guard";
import { dashboardJoinFunnel } from "../src/admin/join-funnel";
import {
  AdminDashboard,
  ErrorPage,
  EventFormPage,
  EventsPage,
  FeaturedFormPage,
  FeaturedPage,
  JoinAttemptPage,
  JoinAttemptsPage,
} from "../src/admin/pages";
import { parseEventListQuery } from "../src/admin/event-list";
import { parseJoinAttemptsQuery } from "../src/admin/table-list";
import { queuePreviewAdmission } from "../src/admin/queue-preview";
import { adminApp } from "../src/admin/routes";
import {
  createEvent,
  ensureAccessLogGin,
  getFeaturedIdByLegacyId,
  listEvents,
  materializeMissingInstances,
  materializeRecurringSeries,
  recordAccess,
  transitionEvent,
  updateEvent,
} from "../src/admin/store";
import {
  parseEventForm,
  parseFeaturedForm,
  utcToWall,
  ValidationError,
} from "../src/admin/validation";
import { parseRecurrenceForm } from "../src/admin/recurrence";
import type { EventListRow, EventRow, FeaturedRow } from "../src/admin/store";
import type { JoinAttemptRow, RosterEntry } from "../src/admin/reads";
import {
  bufferedMemberJson,
  bufferedMemberText,
  declareMemberResult,
  keyedMemberRead,
} from "../src/member-reads";
import * as previews from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import type { Context } from "hono";
import type { QueuePreviewVars } from "../src/admin/queue-preview";
import type { Db } from "../src/db/index";
import {
  activityLog,
  events,
  featuredContents,
  memberDataAccessLogs,
  rsvps,
} from "../src/db/admin-schema";
import { joinAttempts } from "../src/db/schema";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "Europe/London",
};

const at = new Date("2099-11-04T20:00:00Z");
const eventRow: EventRow = {
  id: 1,
  eventKey: "branch-floor-event",
  title: "Friday games",
  game: null,
  description: null,
  startsAt: at,
  endsAt: new Date("2099-11-04T22:00:00Z"),
  timezone: "UTC",
  location: null,
  capacity: null,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 0,
  syncedRevision: 0,
  rsvpOpen: true,
  createdBy: null,
  createdAt: at,
  updatedAt: at,
};
const featuredRow: FeaturedRow = {
  id: 1,
  legacyId: null,
  title: "Friday slot",
  body: "Bring a friend.",
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: true,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: "moderator",
  createdAt: at,
  updatedAt: at,
};

async function eventCount(db: Db): Promise<number> {
  return (await db.select().from(events)).length;
}

async function auditDescriptions(db: Db): Promise<string[]> {
  return (await db.select().from(activityLog)).map((r) => r.description);
}

describe("admin validation rejections (pure parser pins, no DB)", () => {
  it("refuses a non-string, non-number capacity instead of erasing the cap", () => {
    let caught: unknown;
    try {
      parseEventForm({ ...FORM, capacity: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).fields).toEqual({
      capacity: "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.",
    });
  });

  it("keeps a numeric capacity from JSON callers and null for blank input", () => {
    expect(parseEventForm({ ...FORM, capacity: 8 }).capacity).toBe(8);
    expect(parseEventForm({ ...FORM, capacity: "" }).capacity).toBeNull();
    for (const bad of ["0", "2147483648", "1.5", "abc"]) {
      let caught: unknown;
      try {
        parseEventForm({ ...FORM, capacity: bad });
      } catch (error) {
        caught = error;
      }
      expect((caught as ValidationError).fields.capacity).toContain("Capacity is a headcount");
    }
  });

  it("accepts an exotic whole-number count literal and refuses a rounded fraud", () => {
    expect(
      parseRecurrenceForm({
        recurrence_frequency: "weekly",
        recurrence_count: "100e-2",
        starts_at: FORM.starts_at,
      })?.count,
    ).toBe(1);
    let caught: unknown;
    try {
      parseRecurrenceForm({
        recurrence_frequency: "weekly",
        recurrence_count: "9.9999999999999999e-1",
        starts_at: FORM.starts_at,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ValidationError).fields).toEqual({
      recurrence_count: "Occurrences must be between 1 and 52.",
    });
  });

  it("skips the repeat-until comparison when the start date itself is unparsable", () => {
    const rule = parseRecurrenceForm({
      recurrence_frequency: "weekly",
      recurrence_count: "3",
      starts_at: "2026-13-45 20:00",
      recurrence_ends_on: "2026-01-01",
    });
    expect(rule).toEqual({
      frequency: "weekly",
      count: 3,
      endsOn: new Date("2026-01-01T00:00:00Z"),
    });
    let caught: unknown;
    try {
      parseRecurrenceForm({
        recurrence_frequency: "weekly",
        recurrence_count: "3",
        starts_at: "2026-11-04 20:00",
        recurrence_ends_on: "2026-01-01",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ValidationError).fields).toEqual({
      recurrence_ends_on: "The repeat-until date is before the first meeting.",
    });
  });

  it("falls back to the wall time when the edit carrier is garbage", () => {
    const parsed = parseEventForm(FORM, { startsAtUtc: "garbage", endsAtUtc: "garbage" });
    expect(parsed.startsAtUtc.toISOString()).toBe("2099-11-04T20:00:00.000Z");
    expect(parsed.endsAtUtc.toISOString()).toBe("2099-11-04T22:00:00.000Z");
  });

  it("reads an explicit hex count literal as its integer value", () => {
    expect(
      parseRecurrenceForm({
        recurrence_frequency: "weekly",
        recurrence_count: "0x10",
        starts_at: FORM.starts_at,
      })?.count,
    ).toBe(16);
  });

  it("renders UTC midnight without the locale's 24-hour overflow", () => {
    expect(utcToWall(new Date("2026-01-01T00:00:00Z"), "UTC")).toBe("2026-01-01 00:00");
  });

  it("featured windows reject BC, year zero, and impossible seconds by shape", () => {
    for (const [starts_at, ends_at] of [
      ["2026-11-04 20:00 BC", ""],
      ["0000-11-04 20:00", ""],
      ["2026-11-04 20:00:60", ""],
      ["2026-11-04 20:00", "2026-11-04 19:00"],
    ] as const) {
      let caught: unknown;
      try {
        parseFeaturedForm({ title: "Slot", starts_at, ends_at });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ValidationError);
    }
    expect(parseFeaturedForm({ title: "Slot" }).startsAtUtc).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin create rejections leave no rows (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  let cookie = "";
  const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
  const app = () => adminApp({ sessionStore: store, db });

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    cookie = await cookieFor(store, MODERATOR);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await db.delete(featuredContents);
  });

  const post = (path: string, values: Record<string, string>) =>
    app().request(
      path,
      { method: "POST", headers: { cookie }, body: new URLSearchParams(values) },
      liveEnv(),
    );

  it.each([
    ["event_key", "FORGED"],
    ["eventKey", "FORGED"],
  ] as const)("refuses a forged %s with 422 and writes nothing", async (field, value) => {
    const before = await eventCount(db);
    const res = await post("/events", { ...FORM, [field]: value });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Check the highlighted fields and try again.");
    expect(await eventCount(db)).toBe(before);
    expect(await auditDescriptions(db)).toEqual([]);
  });

  it.each([
    ["title", "x".repeat(101), "Keep the title to 100 characters."],
    ["game", "x".repeat(101), "Keep the game to 100 characters."],
    ["description", "x".repeat(1001), "Keep the description to 1000 characters."],
    ["location", "x".repeat(256), "Keep the location to 255 characters."],
    ["title", "Gamenight", "Remove control or invisible characters."],
    ["capacity", "0", "Capacity is a headcount"],
    ["capacity", "2147483648", "Capacity is a headcount"],
    ["capacity", "1.5", "Capacity is a headcount"],
  ])("422s %s without persisting the draft", async (field, value, message) => {
    const res = await post("/events", { ...FORM, [field]: value });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await eventCount(db)).toBe(0);
    expect(await auditDescriptions(db)).toEqual([]);
  });

  it("unknown timezone 422s alone: date parsing is skipped, not stacked", async () => {
    const res = await post("/events", { ...FORM, timezone: "Unknown/Zone", starts_at: "bad" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Unknown timezone");
    expect(html).not.toContain("Not a date and time");
    expect(await eventCount(db)).toBe(0);
  });

  it.each([
    [{ url: "notaurl" }, "Link is a full http(s) URL"],
    [{ image_url: "https://evil.example/x.png" }, "Image URL must be HTTPS"],
    [
      { image_url: "https://cdn.discordapp.com/attachments/1/2.png" },
      "Describe the photo in one plain sentence",
    ],
    [{ image_alt: "x".repeat(256) }, "Keep the alt text to 255 characters."],
    [{ position: "-1" }, "Position is a whole number"],
    [{ starts_at: "2026-11-04 20:00 BC" }, "BC dates are not supported"],
    [{ starts_at: "2026-11-04 20:00:60" }, "Not a date and time"],
    [{ starts_at: "0000-11-04 20:00" }, "Not a date and time"],
  ])("422s featured input %j without persisting the slot", async (overrides, message) => {
    const res = await post("/featured", { title: "Slot", ...overrides });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await db.select().from(featuredContents)).toEqual([]);
  });

  it("422s a featured window that ends before it starts", async () => {
    const res = await post("/featured", {
      title: "Slot",
      starts_at: "2026-11-04 20:00",
      ends_at: "2026-11-04 19:00",
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("The window ends after it starts.");
    expect(await db.select().from(featuredContents)).toEqual([]);
  });

  it.each([
    [{ recurrence_frequency: "weekly" }, "Give a number of occurrences"],
    [{ recurrence_frequency: "daily", recurrence_count: "3" }, "Unknown repeat frequency."],
    [
      { recurrence_frequency: "weekly", recurrence_count: "0" },
      "Occurrences must be between 1 and 52.",
    ],
    [
      { recurrence_frequency: "weekly", recurrence_count: "53" },
      "Occurrences must be between 1 and 52.",
    ],
    [
      { recurrence_frequency: "weekly", recurrence_count: "2.5" },
      "Occurrences must be between 1 and 52.",
    ],
    [
      { recurrence_frequency: "weekly", recurrence_count: "", recurrence_ends_on: "not-a-date" },
      "The repeat-until date is not a date.",
    ],
    [
      {
        recurrence_frequency: "weekly",
        recurrence_count: "",
        recurrence_ends_on: "2026-01-01",
      },
      "The repeat-until date is before the first meeting.",
    ],
  ])("422s recurrence input %j without persisting a half-series", async (overrides, message) => {
    const res = await post("/events", { ...FORM, ...overrides });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await eventCount(db)).toBe(0);
  });

  it("creates the whole weekly series or nothing: count 3.0 persists three drafts", async () => {
    const res = await post("/events", {
      ...FORM,
      recurrence_frequency: "weekly",
      recurrence_count: "3.0",
    });
    expect(res.status).toBe(303);
    const rows = await db.select().from(events);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.status)).toEqual(["draft", "draft", "draft"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin store failure and rollback paths (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  let cookie = "";
  const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
  const app = () => adminApp({ sessionStore: store, db });
  const actor = { id: MODERATOR.userId, username: MODERATOR.username };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    cookie = await cookieFor(store, MODERATOR);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await db.delete(featuredContents);
  });

  const post = (path: string, values: Record<string, string>) =>
    app().request(
      path,
      { method: "POST", headers: { cookie }, body: new URLSearchParams(values) },
      liveEnv(),
    );
  const get = (path: string) => app().request(path, { headers: { cookie } }, liveEnv());

  async function seedEvent(overrides: Partial<typeof events.$inferInsert> & { eventKey: string }) {
    const [row] = await db
      .insert(events)
      .values({
        title: "Seeded",
        timezone: "Europe/London",
        status: "draft",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        ...overrides,
      })
      .returning();
    return row!;
  }

  it("refuses a capacity below occupied seats and leaves the row and audit alone", async () => {
    const row = await seedEvent({ eventKey: "cap-floor-event", capacity: null });
    await db.insert(rsvps).values([
      { eventId: row.id, userId: "100000000000000201", status: "going" },
      { eventId: row.id, userId: "100000000000000202", status: "going" },
    ]);
    const res = await post(`/events/${row.eventKey}`, { ...FORM, capacity: "1" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Occupied seats: 2.");
    const [after] = await db.select().from(events).where(eq(events.eventKey, row.eventKey));
    expect(after?.capacity).toBeNull();
    expect(await auditDescriptions(db)).toEqual([]);
  });

  it("refuses to publish an ended draft with the ends_at reason", async () => {
    const row = await seedEvent({
      eventKey: "ended-draft-event",
      startsAt: new Date("2020-01-01T20:00:00Z"),
      endsAt: new Date("2020-01-01T22:00:00Z"),
    });
    const res = await post(`/events/${row.eventKey}/publish`, {});
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("That transition is not allowed");
    expect(html).toContain("already ended");
    const [after] = await db.select().from(events).where(eq(events.eventKey, row.eventKey));
    expect(after?.status).toBe("draft");
  });

  it("keeps a cancelled event cancelled: publish is refused, never resurrected", async () => {
    const row = await seedEvent({ eventKey: "terminal-event", status: "cancelled" });
    const res = await post(`/events/${row.eventKey}/publish`, {});
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("stays cancelled");
    const [after] = await db.select().from(events).where(eq(events.eventKey, row.eventKey));
    expect(after?.status).toBe("cancelled");
  });

  it("refuses to publish a past event through the same transition page", async () => {
    const row = await seedEvent({
      eventKey: "past-event",
      status: "past",
      startsAt: new Date("2020-01-01T20:00:00Z"),
      endsAt: new Date("2020-01-01T22:00:00Z"),
    });
    const res = await post(`/events/${row.eventKey}/publish`, {});
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Only a draft can be published.");
  });

  it("refuses RSVP pause on a draft and reopen on an ended event", async () => {
    const draft = await seedEvent({ eventKey: "pause-draft-event" });
    const paused = await post(`/events/${draft.eventKey}/rsvp-pause`, {});
    expect(paused.status).toBe(422);
    expect(await paused.text()).toContain("Only published events");
    const ended = await seedEvent({
      eventKey: "reopen-ended-event",
      status: "published",
      rsvpOpen: false,
      startsAt: new Date("2020-01-01T20:00:00Z"),
      endsAt: new Date("2020-01-01T22:00:00Z"),
    });
    const reopened = await post(`/events/${ended.eventKey}/rsvp-reopen`, {});
    expect(reopened.status).toBe(422);
    expect(await reopened.text()).toContain("Only published events");
  });

  it("pausing twice writes one audit row: the repeat is a no-op redirect", async () => {
    const row = await seedEvent({
      eventKey: "double-pause-event",
      status: "published",
      rsvpOpen: true,
    });
    expect((await post(`/events/${row.eventKey}/rsvp-pause`, {})).status).toBe(303);
    expect((await post(`/events/${row.eventKey}/rsvp-pause`, {})).status).toBe(303);
    const [after] = await db.select().from(events).where(eq(events.eventKey, row.eventKey));
    expect(after?.rsvpOpen).toBe(false);
    expect((await auditDescriptions(db)).filter((d) => d.includes("paused RSVPs")).length).toBe(1);
  });

  it("fails closed on corrupt data: an unknown stored status throws, row untouched", async () => {
    const row = await seedEvent({ eventKey: "corrupt-status-event", status: "weird" });
    await expect(transitionEvent(db, actor, row.eventKey, "published")).rejects.toThrow(
      "unknown event status: weird",
    );
    const [after] = await db.select().from(events).where(eq(events.eventKey, row.eventKey));
    expect(after?.status).toBe("weird");
  });

  it("tops up a live weekly series and leaves a cancelled series alone", async () => {
    const parent = await seedEvent({
      eventKey: "series-parent-event",
      recurrenceFrequency: "weekly",
      recurrenceCount: 3,
      recurrenceEndsOn: null,
      recurrenceIndex: 1,
    });
    expect(await materializeRecurringSeries(db)).toBe(2);
    const rows = await db.select().from(events);
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.parentEventId === parent.id).length).toBe(2);
    expect(rows.map((r) => r.status)).toEqual(["draft", "draft", "draft"]);
    await db.delete(events);
    await seedEvent({
      eventKey: "cancelled-series-event",
      status: "cancelled",
      recurrenceFrequency: "weekly",
      recurrenceCount: 3,
      recurrenceEndsOn: null,
      recurrenceIndex: 1,
    });
    expect(await materializeRecurringSeries(db)).toBe(0);
    expect(await eventCount(db)).toBe(1);
  });

  it("records deduped, sorted subjects and writes nothing for an empty set", async () => {
    expect(
      await recordAccess(db, {
        viewerDiscordId: "100000000000000201",
        viewerUserId: "u1",
        resource: "events",
        action: "view",
        subjectUserIds: [],
        route: "admin.events.edit",
      }),
    ).toBe(false);
    expect(await db.select().from(memberDataAccessLogs)).toEqual([]);
    expect(
      await recordAccess(db, {
        viewerDiscordId: "100000000000000201",
        viewerUserId: "u1",
        resource: "events",
        action: "view",
        subjectUserIds: ["u3", "u1", "u2", "u2"],
        route: "admin.events.edit",
      }),
    ).toBe(true);
    const [logged] = await db.select().from(memberDataAccessLogs);
    expect(logged?.subjectUserIds).toEqual(["u2", "u3"]);
    expect(logged?.subjectCount).toBe(2);
  });

  it("provisions the access-log index idempotently and keeps logging after", async () => {
    await ensureAccessLogGin(db);
    await ensureAccessLogGin(db);
    const rows = (await fixture.client`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'member_data_access_logs'
    `) as Array<{ indexname: string }>;
    expect(rows.map((r) => r.indexname)).toContain("member_data_access_logs_subject_user_ids_gin");
    expect(
      await recordAccess(db, {
        viewerDiscordId: "100000000000000201",
        viewerUserId: "u1",
        resource: "events",
        action: "view",
        subjectUserIds: ["u2"],
        route: "admin.events.edit",
      }),
    ).toBe(true);
  });

  it("404s missing events, featured slots, and join attempts without audit writes", async () => {
    for (const [method, path] of [
      ["GET", "/events/no-such-key"],
      ["POST", "/events/no-such-key"],
      ["POST", "/events/no-such-key/publish"],
      ["POST", "/events/no-such-key/rsvp-pause"],
      ["GET", "/featured/999999"],
      ["POST", "/featured/999999"],
      ["POST", "/featured/999999/delete"],
      ["GET", "/join-attempts/abc"],
      ["GET", "/join-attempts/0"],
      ["GET", "/join-attempts/999999"],
    ] as const) {
      const res =
        method === "GET"
          ? await get(path)
          : await post(path, method === "POST" && path.startsWith("/events/no") ? FORM : {});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(await auditDescriptions(db)).toEqual([]);
    expect(await db.select().from(memberDataAccessLogs)).toEqual([]);
  });

  it("editing a deleted featured slot returns 404 instead of crashing", async () => {
    const created = await post("/featured", { title: "Race slot", position: "0" });
    expect(created.status).toBe(303);
    const id = Number(created.headers.get("location")!.split("/").pop()!);
    await db.delete(featuredContents).where(eq(featuredContents.id, id));
    const res = await post(`/featured/${id}`, { title: "Late edit", position: "0" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Featured content not found");
  });

  it("aliases a legacy featured id to its canonical edit page", async () => {
    const [seeded] = await db
      .insert(featuredContents)
      .values({ title: "Legacy slot", legacyId: "77", position: 0 })
      .returning();
    expect(await getFeaturedIdByLegacyId(db, "77")).toBe(seeded!.id);
    expect(await getFeaturedIdByLegacyId(db, "78")).toBeNull();
    const res = await get("/featured-contents/77/edit");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/admin/featured/${seeded!.id}`);
    expect((await get("/featured-contents/78/edit")).status).toBe(404);
  });

  it("shows the join audit trail: list links the attempt, detail names it", async () => {
    const [seeded] = await db
      .insert(joinAttempts)
      .values({
        outcome: "added",
        source: "bot",
        requestId: "req-77",
        discordId: "100000000000000201",
      })
      .returning();
    const list = await get("/join-attempts");
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("req-77");
    const detail = await get(`/join-attempts/${seeded!.id}`);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("added");
    expect(html).toContain("100000000000000201");
  });

  it("renders the join funnel from outcomes only", async () => {
    await db.insert(joinAttempts).values([
      { outcome: "added", discordId: "100000000000000201", requestId: "req-1" },
      { outcome: "denied", discordId: "100000000000000202", requestId: "req-2" },
    ]);
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="funnel-added">1</td>');
    expect(html).toContain('data-testid="funnel-denied">1</td>');
  });

  it("lists with adversarial queries pinned to page one", async () => {
    const first = await get("/events?page=0&status=bogus&sort=bogus&order=sideways");
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Page 1");
    const second = await get("/join-attempts?page=0");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Page 1");
    const third = await get("/featured?published=bogus");
    expect(third.status).toBe(200);
    expect(await third.text()).toContain("No featured content yet.");
  });

  it("creates a listed draft event and persists its moderator audit", async () => {
    const parsed = parseEventForm(FORM);
    const { row } = await createEvent(db, actor, parsed, null);
    expect(row.status).toBe("draft");
    const listed = await listEvents(db, {});
    expect(listed.map((r) => r.eventKey)).toContain(row.eventKey);
    const audits = await db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      subjectType: "Event",
      subjectId: row.eventKey,
      causerId: actor.id,
      description: `created event ${FORM.title}`,
    });
  });

  it("rolls back the whole series and its child audits when the parent audit fails", async () => {
    await fixture.client`
      CREATE FUNCTION reject_parent_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject_type = 'Event'
          AND NEW.properties -> 'recurrenceIndex' ->> 'after' = '1' THEN
          RAISE EXCEPTION 'synthetic parent audit outage';
        END IF;
        RETURN NEW;
      END $$
    `;
    await fixture.client`
      CREATE TRIGGER reject_parent_audit BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_parent_audit()
    `;
    const parsed = parseEventForm(FORM);
    const rule = { frequency: "weekly" as const, count: 3, endsOn: null };
    try {
      await expect(createEvent(db, actor, parsed, rule)).rejects.toThrow();
      expect(await db.select().from(events)).toEqual([]);
      expect(await db.select().from(activityLog)).toEqual([]);
    } finally {
      await fixture.client`DROP TRIGGER reject_parent_audit ON activity_log`;
      await fixture.client`DROP FUNCTION reject_parent_audit()`;
    }
    await createEvent(db, actor, parsed, rule);
    expect(await db.select().from(events)).toHaveLength(3);
    expect(await db.select().from(activityLog)).toHaveLength(3);
  });

  it("a non-series parent materializes nothing", async () => {
    const parent = await seedEvent({ eventKey: "standalone-parent-event" });
    expect(parent.recurrenceFrequency).toBeNull();
    expect(await materializeMissingInstances(db, parent)).toBe(0);
    expect(await eventCount(db)).toBe(1);
  });

  it("an update that moves no times leaves future children alone", async () => {
    const created = await post("/events", {
      ...FORM,
      recurrence_frequency: "weekly",
      recurrence_count: "2",
    });
    expect(created.status).toBe(303);
    const parentKey = created.headers.get("location")!.split("/").pop()!;
    const [parent] = await db.select().from(events).where(eq(events.eventKey, parentKey));
    const [child] = await db.select().from(events).where(eq(events.parentEventId, parent!.id));
    const childAuditsBefore = (await db.select().from(activityLog)).filter(
      (audit) => audit.subjectId === child!.eventKey,
    );
    const res = await post(`/events/${parentKey}`, { ...FORM, title: "Renamed series" });
    expect(res.status).toBe(303);
    const [childAfter] = await db.select().from(events).where(eq(events.id, child!.id));
    expect(childAfter?.startsAt.toISOString()).toBe(child!.startsAt.toISOString());
    expect(childAfter?.updatedAt.toISOString()).toBe(child!.updatedAt.toISOString());
    const childAuditsAfter = (await db.select().from(activityLog)).filter(
      (audit) => audit.subjectId === child!.eventKey,
    );
    expect(childAuditsBefore).toHaveLength(1);
    expect(childAuditsAfter).toEqual(childAuditsBefore);
    expect(await res.text()).toBe("");
  });

  it("a shifted agent-granted child keeps its grant and bumps its version", async () => {
    const [grant] = (await fixture.client`
      INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES ('branch-floor-agent', 'synthetic-company', '326474832151838730', 'hash')
      RETURNING id
    `) as Array<{ id: string }>;
    const created = await post("/events", {
      ...FORM,
      recurrence_frequency: "weekly",
      recurrence_count: "2",
    });
    expect(created.status).toBe(303);
    const parentKey = created.headers.get("location")!.split("/").pop()!;
    const [parent] = await db.select().from(events).where(eq(events.eventKey, parentKey));
    const [child] = await db.select().from(events).where(eq(events.parentEventId, parent!.id));
    await db
      .update(events)
      .set({ agentGrantId: grant!.id, agentVersion: 1 })
      .where(eq(events.id, child!.id));
    const res = await post(`/events/${parentKey}`, {
      ...FORM,
      starts_at: "2099-11-04 21:00",
      ends_at: "2099-11-04 23:00",
    });
    expect(res.status).toBe(303);
    const [moved] = await db.select().from(events).where(eq(events.id, child!.id));
    expect(moved?.startsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
    expect(moved?.endsAt.toISOString()).toBe("2099-11-11T23:00:00.000Z");
    expect(moved?.agentGrantId).toBe(grant!.id);
    expect(moved?.agentVersion).toBe(2);
  });

  it("an unchanged edit through the store still lands an audit row", async () => {
    const parsed = parseEventForm(FORM);
    const { row } = await createEvent(db, actor, parsed, null);
    expect((await db.select().from(activityLog)).length).toBe(1);
    const { row: same } = await updateEvent(db, actor, row.eventKey, parsed);
    expect(same.eventKey).toBe(row.eventKey);
    expect((await db.select().from(activityLog)).length).toBe(2);
  });

  it("ignores a file upload field on the event form and still creates the draft", async () => {
    const body = new FormData();
    for (const [k, v] of Object.entries(FORM)) body.set(k, v);
    body.set("poster", new File(["bytes"], "poster.png", { type: "image/png" }));
    const res = await app().request(
      "/events",
      { method: "POST", headers: { cookie }, body },
      liveEnv(),
    );
    expect(res.status).toBe(303);
    expect(await eventCount(db)).toBe(1);
  });

  it("fails the queue preview audit closed when no audit database is configured", async () => {
    vi.spyOn(previews, "previewFailedJob").mockResolvedValue({
      failure: { id: 7, kind: "sync-event", failedAt: "2026-10-07T00:00:00.000Z" },
      observedAt: "2026-10-07T01:00:00.000Z",
      disposition: { action: "discard-stale", reason: "stale" },
    });
    try {
      const stagingEnv = {
        ...env,
        APP_URL: STAGING_APP_URL,
        QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
        QUEUE_RECONCILE_OPERATOR_ID: MODERATOR.userId,
      } as Env;
      const previewStore = createMemorySessionStore();
      const previewCookie = await cookieFor(previewStore, MODERATOR);
      const res = await new Hono().route("/admin", adminApp(previewStore)).request(
        `${STAGING_APP_URL}/admin/queue/failed/7/preview`,
        {
          headers: { cookie: previewCookie, origin: STAGING_APP_URL },
        },
        stagingEnv,
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview_unavailable" });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("admin error and empty page states (pure render, no DB)", () => {
  it("renders the error page with and without a detail line", () => {
    const bare = String(jsx(ErrorPage, { heading: "Event not found" }));
    expect(bare).toContain("Event not found");
    expect(bare).not.toContain('data-testid="error-detail"');
    expect(bare).toContain("Back to the dashboard");
    const detailed = String(
      jsx(ErrorPage, { heading: "That transition is not allowed", detail: "Only a draft." }),
    );
    expect(detailed).toContain('data-testid="error-detail"');
    expect(detailed).toContain("Only a draft.");
  });

  it("omits optional dashboard widgets when the database is absent", () => {
    const html = String(jsx(AdminDashboard, { actor: { id: "1", username: "mod" } }));
    expect(html).toContain("mod");
    expect(html).not.toContain('data-testid="join-funnel"');
    expect(html).not.toContain('data-testid="top-zero-searches"');
  });

  it("names empty versus populated funnel and search widgets", () => {
    const empty = String(
      jsx(AdminDashboard, { actor: { id: "1", username: "mod" }, funnel: {}, zeroSearches: [] }),
    );
    expect(empty).toContain("No join attempts in the window.");
    expect(empty).toContain("No missed searches.");
    const full = String(
      jsx(AdminDashboard, {
        actor: { id: "1", username: "mod" },
        funnel: { added: 2 },
        zeroSearches: [{ query: "chess", searches: 3, lastSearchedAt: at }],
      }),
    );
    expect(full).toContain('data-testid="funnel-added">2</td>');
    expect(full).toContain("chess");
    expect(full).not.toContain("No missed searches.");
  });

  it("renders an empty join-attempts table and null cells without leak", () => {
    const empty = String(
      jsx(JoinAttemptsPage, {
        rows: [],
        query: parseJoinAttemptsQuery({}),
        hasNext: false,
        outcomes: ["added"],
      }),
    );
    expect(empty).toContain('data-testid="join-attempts-empty"');
    expect(empty).toContain("No join attempts.");
    const nulled: JoinAttemptRow = {
      id: 7,
      outcome: "added",
      source: null,
      requestId: null,
      discordId: null,
      createdAt: at,
    };
    const rows = String(
      jsx(JoinAttemptsPage, {
        rows: [nulled],
        query: parseJoinAttemptsQuery({}),
        hasNext: true,
        outcomes: ["added"],
      }),
    );
    expect(rows).toContain("/admin/join-attempts/7");
    expect(rows).not.toContain("null");
    expect(rows).toContain('rel="next"');
  });

  it("renders a join-attempt detail with em dashes for missing trace fields", () => {
    const html = String(
      jsx(JoinAttemptPage, {
        row: {
          id: 7,
          outcome: "added",
          source: null,
          requestId: null,
          discordId: null,
          createdAt: at,
        },
      }),
    );
    expect(html).toContain("Join attempt 7");
    expect(html).toContain("added");
    expect(html).not.toContain("null");
  });

  it("gates RSVP actions on published, unended events", () => {
    const draft = String(
      EventFormPage({
        mode: "edit",
        row: { ...eventRow, status: "draft" },
        values: {},
        errors: {},
        roster: [],
        rosterQuery: { q: "", sort: "answered", order: "desc", page: 1 },
      }),
    );
    expect(draft).not.toContain('data-testid="rsvp-pause"');
    expect(draft).not.toContain('data-testid="rsvp-reopen"');
    expect(draft).toContain('data-testid="publish-event"');
    const open = String(
      EventFormPage({
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster: [],
        rosterQuery: { q: "", sort: "answered", order: "desc", page: 1 },
      }),
    );
    expect(open).toContain('data-testid="rsvp-pause"');
    expect(open).not.toContain('data-testid="rsvp-reopen"');
    const closed = String(
      EventFormPage({
        mode: "edit",
        row: { ...eventRow, rsvpOpen: false },
        values: {},
        errors: {},
        roster: [],
        rosterQuery: { q: "", sort: "answered", order: "desc", page: 1 },
      }),
    );
    expect(closed).toContain('data-testid="rsvp-reopen"');
    const ended = String(
      EventFormPage({
        mode: "edit",
        row: {
          ...eventRow,
          startsAt: new Date("2020-01-01T20:00:00Z"),
          endsAt: new Date("2020-01-01T22:00:00Z"),
        },
        values: {},
        errors: {},
        roster: [],
        rosterQuery: { q: "", sort: "answered", order: "desc", page: 1 },
      }),
    );
    expect(ended).not.toContain('data-testid="rsvp-pause"');
    expect(ended).not.toContain('data-testid="rsvp-reopen"');
    const cancelled = String(
      EventFormPage({
        mode: "edit",
        row: { ...eventRow, status: "cancelled" },
        values: {},
        errors: {},
        roster: [],
        rosterQuery: { q: "", sort: "answered", order: "desc", page: 1 },
      }),
    );
    expect(cancelled).not.toContain('data-testid="publish-event"');
    expect(cancelled).not.toContain('data-testid="cancel-event"');
  });

  it("badges fill states: uncapped count, seated fraction, full, and over capacity", () => {
    const rows: EventListRow[] = [
      { ...eventRow, eventKey: "uncapped", goingCount: 3, capacity: null },
      { ...eventRow, eventKey: "seated", goingCount: 2, capacity: 5 },
      { ...eventRow, eventKey: "full", goingCount: 5, capacity: 5 },
      { ...eventRow, eventKey: "over", goingCount: 6, capacity: 5 },
    ];
    const html = String(jsx(EventsPage, { rows, query: parseEventListQuery({}), hasNext: true }));
    expect(html).toContain("3 going");
    expect(html).toContain("2 of 5 going");
    expect(html).toContain('data-testid="event-fill-badge-full"');
    expect(html).toContain('data-testid="event-over-capacity-over"');
    expect(html).not.toContain('data-testid="event-fill-badge-seated"');
    expect(html).toContain('rel="next"');
  });

  it("shows publish only on drafts and cancel on drafts and published rows", () => {
    const page = (status: EventRow["status"]) =>
      String(
        jsx(EventsPage, {
          rows: [{ ...eventRow, status, goingCount: 0 }],
          query: parseEventListQuery({}),
          hasNext: false,
        }),
      );
    expect(page("draft")).toContain(`/admin/events/${eventRow.eventKey}/publish`);
    expect(page("published")).not.toContain(`/admin/events/${eventRow.eventKey}/publish`);
    expect(page("published")).toContain(`/admin/events/${eventRow.eventKey}/cancel`);
    expect(page("cancelled")).not.toContain(`/admin/events/${eventRow.eventKey}/cancel`);
  });

  it("renders unknown roster members plainly and keeps the search box", () => {
    const roster: RosterEntry[] = [
      { userId: "u1", username: "  ", status: "going", answeredAt: at },
    ];
    const html = String(
      EventFormPage({
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster,
        rosterQuery: { q: "", sort: "answered", order: "desc", page: 1 },
      }),
    );
    expect(html).toContain("Unknown member");
    expect(html).toContain("RSVPs (1)");
    expect(html).toContain('name="roster_q"');
  });

  it("shows em dashes for an unscheduled featured window", () => {
    const html = String(
      jsx(FeaturedPage, {
        rows: [featuredRow],
        query: { published: "", q: "", sort: "position", order: "asc" },
        now: at,
      }),
    );
    expect(html).toContain("—");
    expect(html).toContain('data-testid="featured-position-1">0</td>');
  });

  it("creates without a preview or delete form; edits preview visibility honestly", () => {
    const fresh = String(
      jsx(FeaturedFormPage, {
        mode: "new",
        values: {},
        errors: {},
        appUrl: "https://next.example.test",
      }),
    );
    expect(fresh).toContain("Create");
    expect(fresh).not.toContain('data-testid="featured-preview"');
    expect(fresh).not.toContain('data-testid="delete-featured"');
    const hidden = String(
      jsx(FeaturedFormPage, {
        mode: "edit",
        row: { ...featuredRow, isPublished: false },
        values: {},
        errors: {},
        appUrl: "https://next.example.test",
      }),
    );
    expect(hidden).toContain('data-testid="featured-preview-hidden"');
    expect(hidden).toContain('data-testid="delete-featured"');
    const live = String(
      jsx(FeaturedFormPage, {
        mode: "edit",
        row: featuredRow,
        values: {},
        errors: {},
        appUrl: "https://next.example.test",
      }),
    );
    expect(live).not.toContain('data-testid="featured-preview-hidden"');
    expect(live).toContain("Friday slot");
  });
});

describe("admin guard denials (memory store, no DB)", () => {
  it("serves a moderator from the test-only memory store", async () => {
    const store = memoryStoreForTests();
    const cookie = await cookieFor(store, MODERATOR);
    const res = await adminApp(store).request("/", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(MODERATOR.username);
  });

  it("404s an unknown panel path at the child root instead of crashing", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const res = await adminApp(store).request("/no-such-panel", { headers: { cookie } }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("answers HEAD through the same read boundary without caching", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const res = await adminApp(store).request("/", { method: "HEAD", headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("bounces an expired bearer to OAuth instead of 403ing a member", async () => {
    const store = createMemorySessionStore();
    const { newSessionToken } = await import("../src/sessions");
    const { serializeSigned: serializeBearer } = await import("hono/utils/cookie");
    const token = newSessionToken();
    const cookie = (
      await serializeBearer("__Host-two_session", token, env.SESSION_SECRET!, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const res = await adminApp(store).request("/events", { headers: { cookie } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it("503s without any session store instead of deciding open or closed", async () => {
    const { newSessionToken } = await import("../src/sessions");
    const { serializeSigned } = await import("hono/utils/cookie");
    const token = newSessionToken();
    const cookie = (
      await serializeSigned("__Host-two_session", token, env.SESSION_SECRET!, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const res = await adminApp().request("/events", { headers: { cookie } }, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("We will be right back");
  });

  it("keeps member reads and writes behind the non-moderator gate", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MEMBER);
    for (const [method, path] of [
      ["GET", "/events"],
      ["GET", "/featured"],
      ["GET", "/join-attempts"],
      ["POST", "/events"],
      ["POST", "/featured"],
      ["POST", "/events/abc/publish"],
    ] as const) {
      const res = await adminApp(store).request(path, { method, headers: { cookie } }, env);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.text()).toContain("Forbidden");
    }
  });

  it("redirects legacy bookmarks without touching the database", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const app = adminApp(store);
    for (const [path, location] of [
      ["/events/create", "/admin/events/new"],
      ["/events/abc/edit", "/admin/events/abc"],
      ["/featured-contents", "/admin/featured"],
      ["/featured-contents/create", "/admin/featured/new"],
    ] as const) {
      const res = await app.request(path, { headers: { cookie } }, env);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(location);
    }
    const bad = await app.request("/featured-contents/abc/edit", { headers: { cookie } }, env);
    expect(bad.status).toBe(404);
    expect(await bad.text()).toContain("Featured content not found");
  });

  it("renders the dashboard without the funnel when no database is configured", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const res = await adminApp(store).request("/", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(MODERATOR.username);
    expect(html).not.toContain('data-testid="join-funnel"');
  });

  it("503s list and transition routes without a database instead of crashing", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const app = adminApp(store);
    const list = await app.request("/events", { headers: { cookie } }, env);
    expect(list.status).toBe(503);
    expect(await list.text()).toContain("Admin temporarily unavailable");
    const action = await app.request(
      "/events/abc/publish",
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(action.status).toBe(503);
    expect(await action.text()).toContain("Admin temporarily unavailable");
  });
});

describe("admin guard direct seams (memory store, no DB)", () => {
  it("refuses a declared member response without an observed keyed query", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const { adminGuard } = await import("../src/admin/guard");
    const inner = new Hono<QueuePreviewVars>();
    inner.use("/*", adminGuard({ sessionStore: store }));
    inner.get("/ping", (c) => {
      c.set("access", { resource: "events", action: "view", route: "t.ping" });
      return keyedMemberRead(async () => {
        declareMemberResult(["100000000000000299"]);
        return bufferedMemberText(c, "pong");
      });
    });
    const res = await inner.request("/ping", { headers: { cookie } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses a read that declares no access metadata", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const { adminGuard } = await import("../src/admin/guard");
    const inner = new Hono<QueuePreviewVars>();
    inner.use("/*", adminGuard({ sessionStore: store }));
    inner.get("/ping", (c) => bufferedMemberText(c, "pong"));
    const res = await inner.request("/ping", { headers: { cookie } }, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Member data is temporarily unavailable.");
  });

  it("fails closed without leaking when the session read throws a non-error", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const broken = {
      ...store,
      get: async (): Promise<never> => {
        throw "string failure";
      },
    };
    const original = console.error;
    console.error = () => {};
    try {
      const res = await adminApp({ sessionStore: broken }).request(
        "/events",
        { headers: { cookie } },
        env,
      );
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain("We will be right back");
      expect(html).not.toContain("string failure");
    } finally {
      console.error = original;
    }
  });
});

describe("admin queue preview admission (no DB)", () => {
  it("fails closed when a 200 response carries no preview audit context", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("/ping/*", (c, next) =>
      queuePreviewAdmission(c as unknown as Context<QueuePreviewVars>, next),
    );
    app.get("/ping/preview", (c) => bufferedMemberJson(c, { ok: true }));
    const stagingEnv: Env = {
      ...env,
      APP_URL: STAGING_APP_URL,
      QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
      QUEUE_RECONCILE_OPERATOR_ID: "100000000000000111",
    };
    const res = await app.request(
      `${STAGING_APP_URL}/ping/preview`,
      { headers: { origin: STAGING_APP_URL } },
      stagingEnv,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "preview_unavailable" });
  });

  it("keeps a stale fill from overwriting a newer published snapshot", async () => {
    const stub = {} as Db;
    let resolveStale!: (v: Record<string, number>) => void;
    let resolveFresh!: (v: Record<string, number>) => void;
    const stale = new Promise<Record<string, number>>((r) => {
      resolveStale = r;
    });
    const fresh = new Promise<Record<string, number>>((r) => {
      resolveFresh = r;
    });
    const id = "conn-stale-pin";
    const first = dashboardJoinFunnel(stub, id, 5000, () => stale);
    const second = dashboardJoinFunnel(stub, id, 5000, () => fresh);
    resolveFresh({ fresh: 2 });
    await expect(second).resolves.toEqual({ fresh: 2 });
    resolveStale({ stale: 1 });
    await expect(first).resolves.toEqual({ stale: 1 });
    await expect(
      dashboardJoinFunnel(stub, id, 5000, () => Promise.reject(new Error("unread"))),
    ).resolves.toEqual({
      fresh: 2,
    });
  });
});

describe("admin join list empty copy (pure render, no DB)", () => {
  it("shows the empty copy and a previous-page link on later pages", () => {
    const html = String(
      jsx(JoinAttemptsPage, {
        rows: [],
        query: parseJoinAttemptsQuery({ page: "2" }),
        hasNext: false,
        outcomes: ["added"],
      }),
    );
    expect(html).toContain("No join attempts.");
    expect(html).toContain("Page 2");
    expect(html).toContain('rel="prev"');
    expect(html).toContain("Previous");
  });
});
