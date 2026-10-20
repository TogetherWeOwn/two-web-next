// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: POST /admin/events/:key
// Acceptance: omitted PATCH fields must resolve from the authoritative row
// inside the same transaction/row lock that commits the update, not from a
// pre-lock snapshot. Two overlapping disjoint partial edits must both
// survive: an omitted title/location/capacity/game or UTC instant in the
// later edit must never silently revert the earlier committed edit, and a
// reschedule a concurrent title-only edit omitted must shift a series
// exactly once. The merged current state is judged under the lock
// (occupied seats, published-location), timezone/DST-fold semantics for
// omitted instants are retained, and audit rows, agent-version bumps and
// write-backs reflect only what each edit actually changed after commit.
//
// Determinism: a holder transaction takes the event row FOR UPDATE, the
// first PATCH is started and observed blocked on that lock in
// pg_stat_activity, then the second PATCH is started and observed blocked
// too — so both route handlers snapshot the pre-edit row — and only then
// is the holder released. Postgres grants the queued row lock in order,
// so the commit order is known. No timing sleeps, no mocked locks.
//
// Live suite on the owned disposable-Postgres fixture, skipped without
// DATABASE_URL like test/event-series-window-acceptance.test.ts. November
// in Europe/London is GMT, so wall text and UTC coincide; the autumn fold
// case uses 2099-10-25, a fold Sunday whose wall 01:30 names 00:30Z (BST)
// and 01:30Z (GMT), and a fresh parse takes the GMT side.
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { dispatchWriteBack } from "../src/admin/writeback";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { agentEventGrants } from "../src/db/schema";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const url = process.env.DATABASE_URL;
const KEY = "patch-race-event";
const CHILD_KEY = "patch-race-child";
const ORIGINAL = {
  title: "Original title",
  game: "Chess",
  description: "Boards out",
  location: "Original hall",
  capacity: 5,
  purpose: null,
  startsAt: new Date("2099-11-04T20:00:00.000Z"),
  endsAt: new Date("2099-11-04T22:00:00.000Z"),
};

describe.skipIf(!url)("concurrent disjoint PATCHes preserve omitted fields (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  let cookie = "";
  let jsonEnv: Env;
  const liveEnv = () => ({ ...baseEnv, ADMIN_DB: db }) as Env;
  const native = () => adminApp({ sessionStore: store, db });

  beforeAll(async () => {
    // Holder transaction + two racing request transactions + the lock
    // observer need distinct connections on the shared scoped pool.
    fixture = await createMemberDataFixture(url!, { max: 6 });
    db = fixture.db;
    cookie = await cookieFor(store, MODERATOR);
    jsonEnv = { ...baseEnv, ADMIN_DB: db, SESSION_STORE: store } as unknown as Env;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await db.delete(agentEventGrants);
    vi.mocked(dispatchWriteBack).mockClear();
  });

  const patch = async (key: string, body: unknown) =>
    app.request(
      `/events/${key}`,
      {
        method: "PATCH",
        headers: { cookie, origin: baseEnv.APP_URL, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      jsonEnv,
    );
  const postAction = async (key: string, action: string) =>
    app.request(
      `/events/${key}/${action}`,
      { method: "POST", headers: { cookie, origin: baseEnv.APP_URL } },
      jsonEnv,
    );
  const postForm = (key: string, values: Record<string, string>) =>
    native().request(
      `/events/${key}`,
      { method: "POST", headers: { cookie }, body: new URLSearchParams(values) },
      liveEnv(),
    );

  async function seed(over: Partial<typeof ORIGINAL & { status: string }> = {}) {
    const [row] = await db
      .insert(events)
      .values({
        eventKey: KEY,
        title: ORIGINAL.title,
        game: ORIGINAL.game,
        description: ORIGINAL.description,
        location: ORIGINAL.location,
        capacity: ORIGINAL.capacity,
        timezone: "Europe/London",
        status: "published",
        purpose: null,
        startsAt: ORIGINAL.startsAt,
        endsAt: ORIGINAL.endsAt,
        ...over,
      })
      .returning();
    return row!;
  }

  const stored = async (eventKey: string) =>
    (await db.select().from(events).where(eq(events.eventKey, eventKey)))[0]!;
  const auditsFor = (eventKey: string) =>
    db
      .select()
      .from(activityLog)
      .where(eq(activityLog.subjectId, eventKey))
      .orderBy(asc(activityLog.id));

  async function waitForBlocked(holderPid: number, count: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      // Walk the blocking chain: the second contender queues behind the
      // first, so pg_blocking_pids names the first contender, not the holder.
      const rows = await fixture.client`with recursive blocked(pid) as (
          select pid from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and ${holderPid} = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a
            join blocked b on b.pid = any(pg_blocking_pids(a.pid))
            where a.datname = current_database() and a.wait_event_type = 'Lock'
        ) select count(*)::int as n from blocked`;
      if (Number(rows[0]!.n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`contenders did not reach the held row lock (wanted ${count})`);
  }

  /**
   * Hold the event row lock, start `first` and prove it blocked (so its
   * handler already read its pre-lock snapshot), start `second` and prove
   * it blocked too, then commit the holder. The requests then commit in
   * start order. `holderWork` runs inside the holder transaction, so a
   * test can commit a concurrent change (e.g. a new occupied seat) in the
   * same release. Responses are always awaited, even on barrier failure.
   */
  async function race(
    first: () => Promise<Response>,
    second?: () => Promise<Response>,
    holderWork?: (tx: Db) => Promise<void>,
  ): Promise<Response[]> {
    let pendingFirst: Promise<Response> | undefined;
    let pendingSecond: Promise<Response> | undefined;
    try {
      await db.transaction(async (tx) => {
        const [holder] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await tx.select().from(events).where(eq(events.eventKey, KEY)).for("update");
        if (holderWork) await holderWork(tx as unknown as Db);
        pendingFirst = first();
        await waitForBlocked(holder!.pid, 1);
        if (second) {
          pendingSecond = second();
          await waitForBlocked(holder!.pid, 2);
        }
      });
    } finally {
      await pendingSecond?.catch(() => undefined);
      await pendingFirst?.catch(() => undefined);
    }
    const responses = [await pendingFirst!];
    if (pendingSecond) responses.push(await pendingSecond);
    return responses;
  }

  it("sequential disjoint patches both survive (positive control)", async () => {
    await seed();
    expect((await patch(KEY, { title: "Renamed title" })).status).toBe(200);
    expect((await patch(KEY, { location: "New hall" })).status).toBe(200);
    const row = await stored(KEY);
    expect(row.title).toBe("Renamed title");
    expect(row.location).toBe("New hall");
    expect(row.capacity).toBe(ORIGINAL.capacity);
    expect(row.startsAt.toISOString()).toBe(ORIGINAL.startsAt.toISOString());
    expect(row.endsAt.toISOString()).toBe(ORIGINAL.endsAt.toISOString());
  });

  it("concurrent title-only and location-only patches preserve both edits", async () => {
    await seed();
    const [first, second] = await race(
      () => patch(KEY, { title: "Renamed title" }),
      () => patch(KEY, { location: "New hall" }),
    );
    expect(first!.status).toBe(200);
    expect(second!.status).toBe(200);
    const row = await stored(KEY);
    expect(row.title).toBe("Renamed title");
    expect(row.location).toBe("New hall");
    expect(row.game).toBe(ORIGINAL.game);
    expect(row.description).toBe(ORIGINAL.description);
    expect(row.capacity).toBe(ORIGINAL.capacity);
    expect(row.agentVersion).toBe(1);
    expect(row.startsAt.toISOString()).toBe(ORIGINAL.startsAt.toISOString());
    expect(row.endsAt.toISOString()).toBe(ORIGINAL.endsAt.toISOString());
    // Audit accuracy: the second edit touched only the location; it must
    // not record (or perform) a title revert.
    const logs = await auditsFor(KEY);
    expect(logs).toHaveLength(2);
    expect(logs[0]!.properties).toMatchObject({
      title: { before: ORIGINAL.title, after: "Renamed title" },
    });
    expect(logs[0]!.properties).not.toHaveProperty("location");
    expect(logs[1]!.properties).toMatchObject({
      location: { before: ORIGINAL.location, after: "New hall" },
    });
    expect(logs[1]!.properties).not.toHaveProperty("title");
    // One write-back per committed edit, none before commit.
    expect(vi.mocked(dispatchWriteBack).mock.calls).toHaveLength(2);
    for (const call of vi.mocked(dispatchWriteBack).mock.calls)
      expect(call[1]).toEqual({ eventKey: KEY, status: "published" });
  });

  it("a reschedule survives a concurrent title-only patch and shifts the series exactly once", async () => {
    const parent = await seed();
    await db
      .update(events)
      .set({ recurrenceFrequency: "weekly", recurrenceCount: 2, recurrenceIndex: 1 })
      .where(eq(events.eventKey, KEY));
    await db.insert(events).values({
      eventKey: CHILD_KEY,
      title: ORIGINAL.title,
      game: ORIGINAL.game,
      description: ORIGINAL.description,
      location: ORIGINAL.location,
      capacity: ORIGINAL.capacity,
      timezone: "Europe/London",
      status: "published",
      purpose: null,
      startsAt: new Date("2099-11-11T20:00:00.000Z"),
      endsAt: new Date("2099-11-11T22:00:00.000Z"),
      parentEventId: parent.id,
      recurrenceIndex: 2,
    });
    const [first, second] = await race(
      () => patch(KEY, { starts_at: "2099-11-04 21:00", ends_at: "2099-11-04 23:00" }),
      () => patch(KEY, { title: "Renamed title" }),
    );
    expect(first!.status).toBe(200);
    expect(second!.status).toBe(200);
    const row = await stored(KEY);
    expect(row.title).toBe("Renamed title");
    expect(row.startsAt.toISOString()).toBe("2099-11-04T21:00:00.000Z");
    expect(row.endsAt.toISOString()).toBe("2099-11-04T23:00:00.000Z");
    // The child shifted +1h with the reschedule; the title edit, which
    // omitted the instants, must not shift it back.
    const child = await stored(CHILD_KEY);
    expect(child.startsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
    expect(child.endsAt.toISOString()).toBe("2099-11-11T23:00:00.000Z");
    const logs = await auditsFor(KEY);
    expect(logs).toHaveLength(2);
    expect(logs[1]!.properties).toMatchObject({
      title: { before: ORIGINAL.title, after: "Renamed title" },
    });
    expect(logs[1]!.properties).not.toHaveProperty("startsAt");
    expect(logs[1]!.properties).not.toHaveProperty("endsAt");
  });

  it("a capacity cut survives a concurrent patch that omits capacity", async () => {
    const parent = await seed();
    await db.insert(rsvps).values([
      { eventId: parent.id, userId: "100000000000000401", status: "going" },
      { eventId: parent.id, userId: "100000000000000402", status: "going" },
    ]);
    const [first, second] = await race(
      () => patch(KEY, { capacity: 2 }),
      () => patch(KEY, { game: "Go" }),
    );
    expect(first!.status).toBe(200);
    expect(second!.status).toBe(200);
    const row = await stored(KEY);
    expect(row.capacity).toBe(2);
    expect(row.game).toBe("Go");
    const logs = await auditsFor(KEY);
    expect(logs).toHaveLength(2);
    expect(logs[1]!.properties).not.toHaveProperty("capacity");
  });

  it("a reschedule into the DST fold survives a concurrent patch that omits the instants", async () => {
    // 2099-10-24 is still BST in Europe/London: wall 20:00 is 19:00Z.
    await seed({
      startsAt: new Date("2099-10-24T19:00:00.000Z"),
      endsAt: new Date("2099-10-24T20:00:00.000Z"),
    });
    const [first, second] = await race(
      () => patch(KEY, { starts_at: "2099-10-25 01:30", ends_at: "2099-10-25 02:30" }),
      () => patch(KEY, { location: "Fold hall" }),
    );
    expect(first!.status).toBe(200);
    expect(second!.status).toBe(200);
    const row = await stored(KEY);
    expect(row.location).toBe("Fold hall");
    // The fold wall minute resolves to the second (GMT) occurrence.
    expect(row.startsAt.toISOString()).toBe("2099-10-25T01:30:00.000Z");
    expect(row.endsAt.toISOString()).toBe("2099-10-25T02:30:00.000Z");
  });

  it("capacity is judged against occupied seats committed before the lock is granted", async () => {
    const parent = await seed();
    await db
      .insert(rsvps)
      .values({ eventId: parent.id, userId: "100000000000000501", status: "going" });
    const before = await stored(KEY);
    const [res] = await race(
      () => patch(KEY, { capacity: 1 }),
      undefined,
      async (tx) => {
        await tx
          .insert(rsvps)
          .values({ eventId: parent.id, userId: "100000000000000502", status: "going" });
      },
    );
    expect(res!.status).toBe(422);
    const body = (await res!.json()) as { fields?: Record<string, string> };
    expect(body.fields?.capacity).toContain("Occupied seats: 2");
    // The refused edit changed no event field (the holder's own RSVP insert
    // legitimately advances the trigger-owned sync counters, so compare the
    // editable fields rather than the whole row).
    const after = await stored(KEY);
    expect({
      title: after.title,
      game: after.game,
      description: after.description,
      location: after.location,
      capacity: after.capacity,
      status: after.status,
      purpose: null,
      startsAt: after.startsAt,
      endsAt: after.endsAt,
      updatedAt: after.updatedAt,
    }).toEqual({
      title: before.title,
      game: before.game,
      description: before.description,
      location: before.location,
      capacity: before.capacity,
      status: before.status,
      purpose: null,
      startsAt: before.startsAt,
      endsAt: before.endsAt,
      updatedAt: before.updatedAt,
    });
    expect(await auditsFor(KEY)).toHaveLength(0);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("a blank-location patch is refused once a concurrent publish commits first", async () => {
    await seed({ status: "draft" });
    const [publish, blanking] = await race(
      () => postAction(KEY, "publish"),
      () => patch(KEY, { location: "" }),
    );
    expect(publish!.status).toBe(200);
    expect(blanking!.status).toBe(422);
    const body = (await blanking!.json()) as { fields?: Record<string, string> };
    expect(body.fields?.location).toBe("Add a location before publishing.");
    const row = await stored(KEY);
    expect(row.status).toBe("published");
    expect(row.location).toBe(ORIGINAL.location);
    // Only the publish audited and wrote back; the refused edit left none.
    expect(await auditsFor(KEY)).toHaveLength(1);
    expect(vi.mocked(dispatchWriteBack).mock.calls).toHaveLength(1);
  });

  it("an omitted fold instant keeps its exact GMT-side UTC instant", async () => {
    await seed({
      startsAt: new Date("2099-10-25T01:30:00.000Z"),
      endsAt: new Date("2099-10-25T02:30:00.000Z"),
    });
    const res = await patch(KEY, { title: "Fold-safe rename" });
    expect(res.status).toBe(200);
    const row = await stored(KEY);
    expect(row.title).toBe("Fold-safe rename");
    expect(row.startsAt.toISOString()).toBe("2099-10-25T01:30:00.000Z");
    expect(row.endsAt.toISOString()).toBe("2099-10-25T02:30:00.000Z");
  });

  it("each moderator patch on a grant-owned event advances the agent version once", async () => {
    const [grant] = await db
      .insert(agentEventGrants)
      .values({
        agentId: "patch-race-agent",
        companyId: "patch-race-company",
        guildId: "100000000000000600",
        verifierHash: "a".repeat(64),
      })
      .returning();
    await seed();
    await db
      .update(events)
      .set({ agentGrantId: grant!.id, agentVersion: 3 })
      .where(eq(events.eventKey, KEY));
    expect((await patch(KEY, { title: "Renamed title" })).status).toBe(200);
    expect((await patch(KEY, { location: "New hall" })).status).toBe(200);
    const row = await stored(KEY);
    expect(row.agentVersion).toBe(5);
    expect(row.title).toBe("Renamed title");
    expect(row.location).toBe("New hall");
  });

  it("the full-form admin edit still writes exactly the submitted fields", async () => {
    await seed();
    const res = await postForm(KEY, {
      title: "Form title",
      game: "Go",
      description: "Form description",
      location: "Form hall",
      capacity: "9",
      starts_at: "2099-11-04 21:00",
      ends_at: "2099-11-04 23:30",
      timezone: "Europe/London",
    });
    expect(res.status).toBe(303);
    const row = await stored(KEY);
    expect(row.title).toBe("Form title");
    expect(row.game).toBe("Go");
    expect(row.description).toBe("Form description");
    expect(row.location).toBe("Form hall");
    expect(row.capacity).toBe(9);
    expect(row.startsAt.toISOString()).toBe("2099-11-04T21:00:00.000Z");
    expect(row.endsAt.toISOString()).toBe("2099-11-04T23:30:00.000Z");
  });
});
