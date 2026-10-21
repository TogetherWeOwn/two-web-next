// route-inventory: POST /admin/events/:key
// route-inventory: PATCH /events/:key
// Acceptance: Events edit scopes, end series, and bulk publish/cancel.
//
// ACCEPTANCE-OWNED (paired build card builds on this branch): the Builder must
// not edit this file. Test corrections go back to the tests card. Every test
// below targets the spec in the parent design card (recurring event series,
// PR-D slice): series-wide vs this-only edits, clobber warning, atomic set
// capacity floor, end series, and bulk publish/cancel with per-row audit and
// per-mirrored-row Discord write-back.
//
// Locked contract for the Builder (behavioral; JSON shapes are normative):
//
// 1. Scope selector. PATCH /events/:key (JSON) and POST /admin/events/:key
//    (form) accept `scope`: "this" | "series". Defaults: a parent edit is
//    series-wide, a child edit is this-only; an explicit scope wins. Any other
//    scope value is 422 `{ error: "invalid", fields: { scope: SCOPE_ERROR } }`
//    (JSON) / the form error page (admin form).
// 2. Series-wide edit (parent key, scope "series"). Content fields (title,
//    game, description, accessibility notes, timezone, location, organizer,
//    join URL/instructions, capacity) overwrite on every not-yet-started
//    instance including drafts, even when a night carried its own override
//    (clobber-with-warning). Times shift by the existing absolute delta
//    (`shiftFutureChildren`). Status never cascades; rule columns
//    (frequency/count/ends-on) stay immutable. The JSON response carries
//    `meta: { scope: "series", touched: <n>, clobberWarning: CLOBBER_COPY }`
//    where touched counts every updated row (parent + instances). The admin
//    edit form shows the scope selector and the CLOBBER_COPY warning.
// 3. This-only edit. Exactly one row changes, one audit row names it, and the
//    JSON response carries `meta: { scope: "this", touched: 1 }`.
// 4. Child time edits never shift siblings; a parent time edit shifts only
//    not-yet-started instances (existing `shiftFutureChildren` behavior,
//    pinned here as controls).
// 5. Set capacity floor. A series-wide edit whose capacity is below any
//    touched row's going count is refused atomically with 422 and
//    `fields.capacity` containing CAPACITY_BELOW_GOING: no row changes, no
//    audit rows, no waitlist promotions, no dispatched write-backs.
// 6. End series. POST /events/:key/end-series with `{ confirm: true }` on a
//    parent sets the parent's recurrenceEndsOn to today's date in the host
//    zone (stored as UTC midnight, the `occurrences()` convention), leaves
//    status and all other rule columns untouched, and leaves every instance
//    byte-identical (published stay bookable, drafts stay drafts). Reconcile
//    (`materializeRecurringSeries`) creates nothing further for the series.
//    Ending is one-way: there is no resume route (POST .../resume-series is
//    404); to resume, create a new series. Without `confirm: true` the action
//    is 422 `{ error: "invalid", fields: { confirm: CONFIRM_END } }` with no
//    writes. A child key is 422 with no writes.
// 7. Bulk publish. POST /events/:key/bulk-publish with `{ confirm: true }` on
//    a parent publishes every upcoming draft in the series (parent included;
//    the existing per-row publish guards still apply), skips rows that are
//    not drafts, writes one audit row per touched row, and dispatches one
//    Discord write-back per mirrored row. Without confirm: 422
//    `fields.confirm = CONFIRM_BULK`, no writes. A child key is 422.
// 8. Bulk cancel. POST /events/:key/bulk-cancel with `{ confirm: true }` on a
//    parent cancels every upcoming draft or published row in the series
//    (parent included), leaves past/cancelled rows untouched, writes one
//    audit row per touched row, and dispatches one write-back per mirrored
//    row. Confirm and child-key rules as in (7).
// 9. Past/archive read-only. Series-wide edits and bulk actions never touch
//    started or past instances (times, content and status all preserved).
//
// Out of scope here (sibling cards own them): monthly patterns, series
// follow/fan-out, and the series page at /events/<parentKey>/series. The JSON
// contract above is normative; admin-form twins of end-series/bulk are the
// Builder's choice, and the series page wires these JSON actions.
//
// Live suite on the owned disposable-Postgres fixture, skipped without
// DATABASE_URL like test/admin-branch-floor.test.ts. November in
// Europe/London is GMT, so wall text and UTC coincide exactly.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { materializeRecurringSeries } from "../src/admin/store";
import { dispatchWriteBack } from "../src/admin/writeback";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { CAPACITY_BELOW_GOING } from "../src/events/waitlist";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const CLOBBER_COPY = "This replaces any per-night changes on upcoming nights.";
const SCOPE_ERROR = 'Scope must be "this" or "series".';
const CONFIRM_BULK = "Confirm this bulk action.";
const CONFIRM_END = "Confirm ending this series.";

const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "10",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "Europe/London",
};

// Addressed rows need ULID-shaped keys (eventKeyAllowed); the parent is the
// addressed row for series actions, children for this-only pins.
const PARENT_KEY = "01K00000000000000000000101";
const CHILD_A_KEY = "01K00000000000000000000102";
const CHILD_B_KEY = "01K00000000000000000000103";
const CHILD_C_KEY = "01K00000000000000000000104";
const CHILD_D_KEY = "01K00000000000000000000105";

type ChildSeed = {
  key: string;
  startsAt: string;
  endsAt: string;
  status?: "draft" | "published" | "cancelled" | "past";
  title?: string;
  location?: string;
  capacity?: number;
};

describe.skipIf(!process.env.DATABASE_URL)("event series edit scopes (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  let cookie = "";
  let jsonEnv: Env;
  const liveEnv = () => ({ ...baseEnv, ADMIN_DB: db }) as Env;
  const native = () => adminApp({ sessionStore: store, db });

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    cookie = await cookieFor(store, MODERATOR);
    jsonEnv = { ...baseEnv, ADMIN_DB: db, SESSION_STORE: store } as unknown as Env;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
    vi.mocked(dispatchWriteBack).mockClear();
  });

  const postForm = (path: string, values: Record<string, string>) =>
    native().request(
      path,
      { method: "POST", headers: { cookie }, body: new URLSearchParams(values) },
      liveEnv(),
    );
  const getEditPage = (key: string) =>
    native().request(`/events/${key}`, { headers: { cookie } }, liveEnv());
  const patchJson = (key: string, body: unknown) =>
    app.request(
      `/events/${key}`,
      {
        method: "PATCH",
        headers: { cookie, origin: baseEnv.APP_URL, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      jsonEnv,
    );
  async function seedSeries(
    children: ChildSeed[],
    parentStatus: "draft" | "published" = "published",
  ) {
    const [parent] = await db
      .insert(events)
      .values({
        eventKey: PARENT_KEY,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: parentStatus,
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        recurrenceFrequency: "weekly",
        recurrenceCount: children.length + 1,
        recurrenceIndex: 1,
      })
      .returning();
    const rows = [parent!];
    for (const [index, child] of children.entries()) {
      const [row] = await db
        .insert(events)
        .values({
          eventKey: child.key,
          title: child.title ?? FORM.title,
          game: FORM.game,
          description: FORM.description,
          location: child.location ?? FORM.location,
          capacity: child.capacity ?? 10,
          timezone: "Europe/London",
          status: child.status ?? "published",
          startsAt: new Date(child.startsAt),
          endsAt: new Date(child.endsAt),
          parentEventId: parent!.id,
          recurrenceIndex: index + 2,
        })
        .returning();
      rows.push(row!);
    }
    return rows;
  }

  const upcomingPair = (): ChildSeed[] => [
    { key: CHILD_A_KEY, startsAt: "2099-11-11T20:00:00Z", endsAt: "2099-11-11T22:00:00Z" },
    {
      key: CHILD_B_KEY,
      startsAt: "2099-11-18T20:00:00Z",
      endsAt: "2099-11-18T22:00:00Z",
      status: "draft",
    },
  ];

  const snapshot = async () => ({
    events: await db.select().from(events).orderBy(events.id),
    audits: await db.select().from(activityLog),
    rsvps: await db.select().from(rsvps).orderBy(rsvps.id),
  });

  const stored = async (eventKey: string) =>
    (await db.select().from(events).where(eq(events.eventKey, eventKey)))[0]!;

  const auditsFor = async (eventKey: string) =>
    await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.subjectType, "Event"), eq(activityLog.subjectId, eventKey)));

  it("series-wide PATCH overwrites upcoming instances incl. drafts and warns about clobbering", async () => {
    // Child B carries a per-night override the series edit must replace.
    await seedSeries([
      { ...upcomingPair()[0]! },
      { ...upcomingPair()[1]!, title: "Turkey night (override)", location: "Side room" },
    ]);
    const res = await patchJson(PARENT_KEY, {
      title: "Game night v2",
      location: "Hall B",
      capacity: 12,
      scope: "series",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
      meta: { scope: string; touched: number; clobberWarning?: string };
    };
    expect(body.meta.scope).toBe("series");
    expect(body.meta.touched).toBe(3);
    expect(body.meta.clobberWarning).toBe(CLOBBER_COPY);
    for (const key of [PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY]) {
      const row = await stored(key);
      expect(row.title).toBe("Game night v2");
      expect(row.location).toBe("Hall B");
      expect(row.capacity).toBe(12);
    }
    // Status never cascades: the draft stays a draft, published stay published.
    expect((await stored(CHILD_A_KEY)).status).toBe("published");
    expect((await stored(CHILD_B_KEY)).status).toBe("draft");
    // Rule columns stay immutable; keys stay put.
    const parent = await stored(PARENT_KEY);
    expect(parent.recurrenceFrequency).toBe("weekly");
    expect(parent.recurrenceCount).toBe(3);
    expect(parent.recurrenceEndsOn).toBeNull();
    expect((await stored(CHILD_B_KEY)).eventKey).toBe(CHILD_B_KEY);
  });

  it("a parent PATCH without scope defaults to series-wide", async () => {
    await seedSeries(upcomingPair());
    const res = await patchJson(PARENT_KEY, { title: "Game night v2" });
    expect(res.status).toBe(200);
    expect((await stored(CHILD_A_KEY)).title).toBe("Game night v2");
    expect((await stored(CHILD_B_KEY)).title).toBe("Game night v2");
  });

  it("a child PATCH without scope touches exactly one row (control: current default)", async () => {
    await seedSeries(upcomingPair());
    const before = await snapshot();
    const res = await patchJson(CHILD_A_KEY, { title: "One-night rename" });
    expect(res.status).toBe(200);
    expect((await stored(CHILD_A_KEY)).title).toBe("One-night rename");
    expect((await stored(PARENT_KEY)).title).toBe(before.events[0]!.title);
    expect((await stored(CHILD_B_KEY)).title).toBe(before.events[2]!.title);
    // Sibling rows byte-identical; exactly one audit row names the child.
    const after = await snapshot();
    expect(after.events.filter((r) => r.eventKey !== CHILD_A_KEY)).toEqual(
      before.events.filter((r) => r.eventKey !== CHILD_A_KEY),
    );
    expect(after.audits.length - before.audits.length).toBe(1);
    const childAudits = await auditsFor(CHILD_A_KEY);
    expect(childAudits.length).toBe(1);
    expect(childAudits[0]!.causerId).toBe(MODERATOR.userId);
  });

  it("explicit scope=this on a parent touches exactly one row", async () => {
    await seedSeries(upcomingPair());
    const res = await patchJson(PARENT_KEY, { title: "Parent-only rename", scope: "this" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { scope: string; touched: number } };
    expect(body.meta.scope).toBe("this");
    expect(body.meta.touched).toBe(1);
    expect((await stored(PARENT_KEY)).title).toBe("Parent-only rename");
    expect((await stored(CHILD_A_KEY)).title).toBe(FORM.title);
    expect((await stored(CHILD_B_KEY)).title).toBe(FORM.title);
  });

  it("rejects an unknown scope with the scope field error and no writes", async () => {
    await seedSeries(upcomingPair());
    const before = await snapshot();
    const res = await patchJson(PARENT_KEY, { title: "Game night v2", scope: "everything" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "invalid",
      fields: { scope: SCOPE_ERROR },
    });
    expect(await snapshot()).toEqual(before);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("a child time edit never shifts its siblings (control)", async () => {
    await seedSeries(upcomingPair());
    const res = await patchJson(CHILD_A_KEY, {
      starts_at: "2099-11-11 19:00",
      ends_at: "2099-11-11 21:00",
    });
    expect(res.status).toBe(200);
    const moved = await stored(CHILD_A_KEY);
    expect(moved.startsAt.toISOString()).toBe("2099-11-11T19:00:00.000Z");
    expect(moved.endsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
    const parent = await stored(PARENT_KEY);
    expect(parent.startsAt.toISOString()).toBe("2099-11-04T20:00:00.000Z");
    const sibling = await stored(CHILD_B_KEY);
    expect(sibling.startsAt.toISOString()).toBe("2099-11-18T20:00:00.000Z");
    expect(sibling.endsAt.toISOString()).toBe("2099-11-18T22:00:00.000Z");
  });

  it("a parent time edit shifts only not-yet-started instances (control)", async () => {
    await seedSeries([
      { ...upcomingPair()[0]! },
      {
        key: CHILD_B_KEY,
        startsAt: "2020-01-08T20:00:00Z",
        endsAt: "2020-01-08T22:00:00Z",
        status: "past",
      },
    ]);
    const res = await patchJson(PARENT_KEY, {
      starts_at: "2099-11-04 21:00",
      ends_at: "2099-11-04 23:00",
      scope: "series",
    });
    expect(res.status).toBe(200);
    expect((await stored(CHILD_A_KEY)).startsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
    const past = await stored(CHILD_B_KEY);
    expect(past.startsAt.toISOString()).toBe("2020-01-08T20:00:00.000Z");
    expect(past.endsAt.toISOString()).toBe("2020-01-08T22:00:00.000Z");
  });

  it("a series-wide edit leaves started and past instances alone", async () => {
    await seedSeries([
      { ...upcomingPair()[0]! },
      {
        key: CHILD_B_KEY,
        startsAt: "2020-11-04T20:00:00Z",
        endsAt: "2099-11-18T22:00:00Z",
        title: "Started night",
      },
      {
        key: CHILD_C_KEY,
        startsAt: "2020-11-11T20:00:00Z",
        endsAt: "2020-11-11T22:00:00Z",
        status: "past",
        title: "Past night",
      },
    ]);
    const res = await patchJson(PARENT_KEY, { title: "Game night v2", scope: "series" });
    expect(res.status).toBe(200);
    expect((await stored(CHILD_A_KEY)).title).toBe("Game night v2");
    const started = await stored(CHILD_B_KEY);
    expect(started.title).toBe("Started night");
    expect(started.startsAt.toISOString()).toBe("2020-11-04T20:00:00.000Z");
    const past = await stored(CHILD_C_KEY);
    expect(past.title).toBe("Past night");
    expect(past.status).toBe("past");
  });

  it("refuses a series-wide capacity below any touched row's going count, atomically", async () => {
    const [parent] = await seedSeries(upcomingPair());
    const childA = await stored(CHILD_A_KEY);
    await db.insert(rsvps).values([
      { eventId: childA.id, userId: "100000000000000301", status: "going" },
      { eventId: childA.id, userId: "100000000000000302", status: "going" },
      { eventId: childA.id, userId: "100000000000000303", status: "going" },
      { eventId: parent!.id, userId: "100000000000000304", status: "waitlisted" },
    ]);
    const before = await snapshot();
    // The parent alone could shrink to 2 (nothing going there); child A holds
    // 3 going seats, so the set floor must refuse.
    const res = await patchJson(PARENT_KEY, { capacity: 2, scope: "series" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe("invalid");
    expect(body.fields.capacity).toContain(CAPACITY_BELOW_GOING);
    expect(await snapshot()).toEqual(before);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("admin form POST with scope=series updates the upcoming instances", async () => {
    await seedSeries(upcomingPair());
    const res = await postForm(`/events/${PARENT_KEY}`, {
      ...FORM,
      title: "Game night v2",
      scope: "series",
    });
    expect(res.status).toBe(303);
    expect((await stored(CHILD_A_KEY)).title).toBe("Game night v2");
    expect((await stored(CHILD_B_KEY)).title).toBe("Game night v2");
  });

  it("admin form POST on a parent without scope defaults to series-wide", async () => {
    await seedSeries(upcomingPair());
    const res = await postForm(`/events/${PARENT_KEY}`, { ...FORM, title: "Game night v2" });
    expect(res.status).toBe(303);
    expect((await stored(CHILD_A_KEY)).title).toBe("Game night v2");
    expect((await stored(CHILD_B_KEY)).title).toBe("Game night v2");
  });

  it("admin edit form shows the scope selector and the clobber warning", async () => {
    await seedSeries(upcomingPair());
    const res = await getEditPage(PARENT_KEY);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="scope"');
    expect(html).toContain(CLOBBER_COPY);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event series end (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  let cookie = "";
  let jsonEnv: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    cookie = await cookieFor(store, MODERATOR);
    jsonEnv = { ...baseEnv, ADMIN_DB: db, SESSION_STORE: store } as unknown as Env;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
    vi.mocked(dispatchWriteBack).mockClear();
  });

  const postJson = (key: string, action: string, body: unknown) =>
    app.request(
      `/events/${key}/${action}`,
      {
        method: "POST",
        headers: { cookie, origin: baseEnv.APP_URL, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      jsonEnv,
    );

  const londonToday = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  it("end-series stamps ends-on, leaves instances as-is, and stops reconcile", async () => {
    const [parent] = await db
      .insert(events)
      .values({
        eventKey: PARENT_KEY,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: "published",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        recurrenceFrequency: "weekly",
        recurrenceCount: 4,
        recurrenceIndex: 1,
      })
      .returning();
    const childKeys = [CHILD_A_KEY, CHILD_B_KEY, CHILD_C_KEY];
    const childDates = ["2099-11-11", "2099-11-18", "2099-11-25"];
    for (const [i, key] of childKeys.entries()) {
      await db.insert(events).values({
        eventKey: key,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: i === 0 ? "published" : "draft",
        startsAt: new Date(`${childDates[i]}T20:00:00Z`),
        endsAt: new Date(`${childDates[i]}T22:00:00Z`),
        parentEventId: parent!.id,
        recurrenceIndex: i + 2,
      });
    }
    // Control: with a gap at index 4, reconcile tops the live series up.
    await db.delete(events).where(eq(events.eventKey, CHILD_C_KEY));
    expect(await materializeRecurringSeries(db)).toBe(1);
    // Re-open the gap, then end the series: published stays bookable,
    // drafts stay drafts, and reconcile must create nothing further.
    await db.delete(events).where(eq(events.eventKey, CHILD_C_KEY));
    const instancesBefore = await db
      .select()
      .from(events)
      .where(eq(events.parentEventId, parent!.id))
      .orderBy(events.id);
    const res = await postJson(PARENT_KEY, "end-series", { confirm: true });
    expect(res.status).toBe(200);
    const ended = (await db.select().from(events).where(eq(events.eventKey, PARENT_KEY)))[0]!;
    expect(ended.status).toBe("published");
    expect(ended.recurrenceFrequency).toBe("weekly");
    expect(ended.recurrenceCount).toBe(4);
    expect(ended.recurrenceEndsOn!.toISOString().slice(0, 10)).toBe(londonToday());
    const instancesAfter = await db
      .select()
      .from(events)
      .where(eq(events.parentEventId, parent!.id))
      .orderBy(events.id);
    expect(instancesAfter).toEqual(instancesBefore);
    expect(await materializeRecurringSeries(db)).toBe(0);
    expect(await db.select().from(events).where(eq(events.eventKey, CHILD_C_KEY))).toEqual([]);
  });

  it("end-series without confirmation changes nothing", async () => {
    await db.insert(events).values({
      eventKey: PARENT_KEY,
      title: FORM.title,
      game: FORM.game,
      description: FORM.description,
      location: FORM.location,
      capacity: 10,
      timezone: "Europe/London",
      status: "published",
      startsAt: new Date("2099-11-04T20:00:00Z"),
      endsAt: new Date("2099-11-04T22:00:00Z"),
      recurrenceFrequency: "weekly",
      recurrenceCount: 2,
      recurrenceIndex: 1,
    });
    const before = {
      events: await db.select().from(events),
      audits: await db.select().from(activityLog),
    };
    const res = await postJson(PARENT_KEY, "end-series", {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "invalid",
      fields: { confirm: CONFIRM_END },
    });
    expect(await db.select().from(events)).toEqual(before.events);
    expect(await db.select().from(activityLog)).toEqual(before.audits);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("end-series on a child key is refused with the series untouched", async () => {
    const [parent] = await db
      .insert(events)
      .values({
        eventKey: PARENT_KEY,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: "published",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        recurrenceFrequency: "weekly",
        recurrenceCount: 2,
        recurrenceIndex: 1,
      })
      .returning();
    await db.insert(events).values({
      eventKey: CHILD_A_KEY,
      title: FORM.title,
      game: FORM.game,
      description: FORM.description,
      location: FORM.location,
      capacity: 10,
      timezone: "Europe/London",
      status: "draft",
      startsAt: new Date("2099-11-11T20:00:00Z"),
      endsAt: new Date("2099-11-11T22:00:00Z"),
      parentEventId: parent!.id,
      recurrenceIndex: 2,
    });
    const res = await postJson(CHILD_A_KEY, "end-series", { confirm: true });
    expect(res.status).toBe(422);
    const untouched = (await db.select().from(events).where(eq(events.eventKey, PARENT_KEY)))[0]!;
    expect(untouched.recurrenceEndsOn).toBeNull();
    expect(await db.select().from(activityLog)).toEqual([]);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("there is no resume route: ending is one-way", async () => {
    const res = await postJson(PARENT_KEY, "resume-series", { confirm: true });
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event series bulk publish/cancel (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  let cookie = "";
  let jsonEnv: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    cookie = await cookieFor(store, MODERATOR);
    jsonEnv = { ...baseEnv, ADMIN_DB: db, SESSION_STORE: store } as unknown as Env;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
    vi.mocked(dispatchWriteBack).mockClear();
  });

  const postJson = (key: string, action: string, body: unknown) =>
    app.request(
      `/events/${key}/${action}`,
      {
        method: "POST",
        headers: { cookie, origin: baseEnv.APP_URL, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      jsonEnv,
    );

  const auditSubjects = async () =>
    (await db.select().from(activityLog)).map((row) => ({
      subjectId: row.subjectId,
      causerId: row.causerId,
    }));

  it("bulk-publish publishes every upcoming draft, one audit and one write-back per row", async () => {
    const [parent] = await db
      .insert(events)
      .values({
        eventKey: PARENT_KEY,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: "draft",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        recurrenceFrequency: "weekly",
        recurrenceCount: 4,
        recurrenceIndex: 1,
      })
      .returning();
    const seeds = [
      { key: CHILD_A_KEY, date: "2099-11-11", status: "draft" as const },
      { key: CHILD_B_KEY, date: "2099-11-18", status: "draft" as const },
      { key: CHILD_C_KEY, date: "2099-11-25", status: "published" as const },
    ];
    for (const [i, seed] of seeds.entries()) {
      await db.insert(events).values({
        eventKey: seed.key,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: seed.status,
        startsAt: new Date(`${seed.date}T20:00:00Z`),
        endsAt: new Date(`${seed.date}T22:00:00Z`),
        parentEventId: parent!.id,
        recurrenceIndex: i + 2,
      });
    }
    const res = await postJson(PARENT_KEY, "bulk-publish", { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { event_key: string }[];
      meta: { touched: number };
    };
    expect(body.meta.touched).toBe(3);
    expect(body.data.map((row) => row.event_key)).toEqual([PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY]);
    for (const key of [PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY]) {
      expect((await db.select().from(events).where(eq(events.eventKey, key)))[0]!.status).toBe(
        "published",
      );
    }
    expect(
      (await db.select().from(events).where(eq(events.eventKey, CHILD_C_KEY)))[0]!.status,
    ).toBe("published");
    const subjects = await auditSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects.map((s) => s.subjectId).sort()).toEqual(
      [PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY].sort(),
    );
    expect(subjects.every((s) => s.causerId === MODERATOR.userId)).toBe(true);
    const calls = vi.mocked(dispatchWriteBack).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([, wb]) => wb).sort((a, b) => a.eventKey.localeCompare(b.eventKey))).toEqual(
      [PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY].sort().map((eventKey) => ({
        eventKey,
        status: "published",
      })),
    );
  });

  it("bulk-publish without confirmation changes nothing", async () => {
    await db.insert(events).values({
      eventKey: PARENT_KEY,
      title: FORM.title,
      game: FORM.game,
      description: FORM.description,
      location: FORM.location,
      capacity: 10,
      timezone: "Europe/London",
      status: "draft",
      startsAt: new Date("2099-11-04T20:00:00Z"),
      endsAt: new Date("2099-11-04T22:00:00Z"),
      recurrenceFrequency: "weekly",
      recurrenceCount: 1,
      recurrenceIndex: 1,
    });
    const before = {
      events: await db.select().from(events),
      audits: await db.select().from(activityLog),
    };
    const res = await postJson(PARENT_KEY, "bulk-publish", {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "invalid",
      fields: { confirm: CONFIRM_BULK },
    });
    expect(await db.select().from(events)).toEqual(before.events);
    expect(await db.select().from(activityLog)).toEqual(before.audits);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("bulk-cancel cancels upcoming rows, skips past/cancelled, audits and dispatches per row", async () => {
    const [parent] = await db
      .insert(events)
      .values({
        eventKey: PARENT_KEY,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: "published",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        recurrenceFrequency: "weekly",
        recurrenceCount: 5,
        recurrenceIndex: 1,
      })
      .returning();
    const seeds = [
      { key: CHILD_A_KEY, status: "published" as const, date: "2099-11-11" },
      { key: CHILD_B_KEY, status: "draft" as const, date: "2099-11-18" },
      { key: CHILD_C_KEY, status: "past" as const, date: "2020-11-25" },
      { key: CHILD_D_KEY, status: "cancelled" as const, date: "2099-12-02" },
    ];
    for (const [i, seed] of seeds.entries()) {
      await db.insert(events).values({
        eventKey: seed.key,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: seed.status,
        startsAt: new Date(`${seed.date}T20:00:00Z`),
        endsAt: new Date(`${seed.date}T22:00:00Z`),
        parentEventId: parent!.id,
        recurrenceIndex: i + 2,
      });
    }
    const res = await postJson(PARENT_KEY, "bulk-cancel", { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { event_key: string }[];
      meta: { touched: number };
    };
    expect(body.meta.touched).toBe(3);
    expect(body.data.map((row) => row.event_key)).toEqual([PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY]);
    for (const key of [PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY]) {
      expect((await db.select().from(events).where(eq(events.eventKey, key)))[0]!.status).toBe(
        "cancelled",
      );
    }
    expect(
      (await db.select().from(events).where(eq(events.eventKey, CHILD_C_KEY)))[0]!.status,
    ).toBe("past");
    expect(
      (await db.select().from(events).where(eq(events.eventKey, CHILD_D_KEY)))[0]!.status,
    ).toBe("cancelled");
    const subjects = await auditSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects.every((s) => s.causerId === MODERATOR.userId)).toBe(true);
    const calls = vi.mocked(dispatchWriteBack).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([, wb]) => wb).sort((a, b) => a.eventKey.localeCompare(b.eventKey))).toEqual(
      [PARENT_KEY, CHILD_A_KEY, CHILD_B_KEY].sort().map((eventKey) => ({
        eventKey,
        status: "cancelled",
      })),
    );
  });

  it("bulk-cancel without confirmation changes nothing", async () => {
    await db.insert(events).values({
      eventKey: PARENT_KEY,
      title: FORM.title,
      game: FORM.game,
      description: FORM.description,
      location: FORM.location,
      capacity: 10,
      timezone: "Europe/London",
      status: "published",
      startsAt: new Date("2099-11-04T20:00:00Z"),
      endsAt: new Date("2099-11-04T22:00:00Z"),
      recurrenceFrequency: "weekly",
      recurrenceCount: 1,
      recurrenceIndex: 1,
    });
    const before = {
      events: await db.select().from(events),
      audits: await db.select().from(activityLog),
    };
    const res = await postJson(PARENT_KEY, "bulk-cancel", {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "invalid",
      fields: { confirm: CONFIRM_BULK },
    });
    expect(await db.select().from(events)).toEqual(before.events);
    expect(await db.select().from(activityLog)).toEqual(before.audits);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("bulk actions on a child key are refused with the series untouched", async () => {
    const [parent] = await db
      .insert(events)
      .values({
        eventKey: PARENT_KEY,
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 10,
        timezone: "Europe/London",
        status: "draft",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
        recurrenceFrequency: "weekly",
        recurrenceCount: 2,
        recurrenceIndex: 1,
      })
      .returning();
    await db.insert(events).values({
      eventKey: CHILD_A_KEY,
      title: FORM.title,
      game: FORM.game,
      description: FORM.description,
      location: FORM.location,
      capacity: 10,
      timezone: "Europe/London",
      status: "draft",
      startsAt: new Date("2099-11-11T20:00:00Z"),
      endsAt: new Date("2099-11-11T22:00:00Z"),
      parentEventId: parent!.id,
      recurrenceIndex: 2,
    });
    for (const action of ["bulk-publish", "bulk-cancel"]) {
      const res = await postJson(CHILD_A_KEY, action, { confirm: true });
      expect(res.status).toBe(422);
    }
    expect((await db.select().from(events).where(eq(events.eventKey, PARENT_KEY)))[0]!.status).toBe(
      "draft",
    );
    expect(
      (await db.select().from(events).where(eq(events.eventKey, CHILD_A_KEY)))[0]!.status,
    ).toBe("draft");
    expect(await db.select().from(activityLog)).toEqual([]);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });
});
