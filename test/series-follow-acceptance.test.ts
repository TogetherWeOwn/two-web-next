// Acceptance: series follow with publish fan-out (failing-first).
//
// A member follows a recurring series once and holds a seat in every game
// night; publishing a later instance seats every follower in that same publish
// transaction. This file pins the HTTP contract and the fan-out semantics for
// the paired build change. Do not edit these tests to match an implementation:
// change the implementation to match these tests.
//
// Pinned contract:
// - PUT /events/:parentKey/series/follow (signed-in members only) records the
//   follow, seats the member in every upcoming published instance of the
//   series through the normal RSVP path, and answers 201 on the first follow
//   or 200 when already following with:
//     { data: { following: true, going: <n>, waitlisted: <m>, message: <copy> } }
//   The published upcoming parent is occurrence 1 and seats like any instance.
//   Full instances yield waitlisted answers; instances the member already
//   answered are skipped. going/waitlisted are the member's total standing
//   across the upcoming published instances, and the message names both counts
//   in plain words.
// - DELETE /events/:parentKey/series/follow removes the follow row only:
//   existing going/waitlisted answers stay. 204 on a real unfollow, 404 when
//   not following.
// - Unknown keys, and keys that are not a series parent, answer 404.
//   Signed-out calls answer 401; signed-in non-members answer 403.
// - A series holds at most 500 followers (SERIES_FOLLOWER_CAP). The 501st
//   follow is refused with 409 { error: "series_full" } and plain copy naming
//   the 500 cap; the refused call seats nothing and stores no follow row.
// - Every follow/unfollow call spends exactly one attempt of the member's
//   existing rsvp-write throttle bucket, however many nights it seats.
//   Publish-time fan-out runs as the system actor and charges followers
//   nothing, so it seats even exhausted budgets.
// - Publishing an instance (parent or child) seats every follower holding no
//   answer row on it, in follow order, in the same publish transaction.
//   Fan-out is fire-once per (instance, follower): withdrawing from one night
//   sticks — later publishes and idempotent re-follows never re-seat it.
//   Following again after an unfollow is a new explicit follow and backfills
//   answer-less nights again. Cancelling then re-publishing a series instance
//   re-applies the follow to followers with no answer row and leaves existing
//   answers (including maybe) untouched.
// - Follow rows live in series_follows(parent_event_id, user_id, created_at).
// - The pure fan-out set computation lives in src/events/series-follow.ts:
//   SERIES_FOLLOWER_CAP and computeFanoutTargets(followers, answered).
//
// Deliberately unpinned: following by a child instance key (instance pages
// call the parent-key endpoint), and the exact follow response copy beyond the
// named counts.
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MEMBER, MODERATOR, OUTSIDER } from "./helpers/member-data";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

// Keep the tracked producer real; only its native pools are pinned to our test schema.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const APP_URL = baseEnv.APP_URL;

let keyCounter = 0;
/** Distinct ULID-shaped keys (26 chars, canonical uppercase alphabet). */
const freshKey = () => {
  keyCounter += 1;
  return `01K${"0".repeat(19)}${String(keyCounter).padStart(4, "0")}`;
};

const memberActor = (n: number) => ({
  userId: `1000000000000002${String(n).padStart(2, "0")}`,
  username: `series-follower-${n}`,
  member: true,
  moderator: false,
});

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing test fixture child at index ${index}`);
  return item;
}

type ChildSpec = {
  status: "draft" | "published" | "cancelled";
  capacity?: number | null;
  startsAt?: string;
  endsAt?: string;
};

type SeededSeries = {
  parentId: number;
  parentKey: string;
  children: { id: number; key: string }[];
};

async function seedSeries(
  db: Db,
  opts: {
    parentStatus?: "draft" | "published";
    parentCapacity?: number | null;
    children?: ChildSpec[];
  },
): Promise<SeededSeries> {
  const parentKey = freshKey();
  const [parent] = await db
    .insert(events)
    .values({
      eventKey: parentKey,
      title: "Weekly game night",
      status: opts.parentStatus ?? "published",
      startsAt: new Date("2099-11-04T20:00:00Z"),
      endsAt: new Date("2099-11-04T22:00:00Z"),
      capacity: opts.parentCapacity ?? 10,
      location: "Voice channel",
      recurrenceFrequency: "weekly",
      recurrenceCount: 4,
      recurrenceIndex: 1,
    })
    .returning({ id: events.id });
  if (!parent) throw new Error("series parent insert returned no row");
  const children: { id: number; key: string }[] = [];
  const specs = opts.children ?? [];
  for (const [i, spec] of specs.entries()) {
    const key = freshKey();
    const base = Date.parse("2099-11-04T20:00:00Z") + (i + 1) * 7 * 24 * 3600_000;
    const [child] = await db
      .insert(events)
      .values({
        eventKey: key,
        title: `Weekly game night ${i + 2}`,
        status: spec.status,
        startsAt: spec.startsAt ? new Date(spec.startsAt) : new Date(base),
        endsAt: spec.endsAt ? new Date(spec.endsAt) : new Date(base + 2 * 3600_000),
        capacity: spec.capacity ?? 10,
        location: "Voice channel",
        parentEventId: parent.id,
        recurrenceIndex: i + 2,
      })
      .returning({ id: events.id });
    if (!child) throw new Error("series child insert returned no row");
    children.push({ id: child.id, key });
  }
  return { parentId: parent.id, parentKey, children };
}

/** Ordinary published event for spending the shared write budget against. */
async function seedSinkEvent(db: Db): Promise<string> {
  const key = freshKey();
  await db.insert(events).values({
    eventKey: key,
    title: "Budget sink",
    status: "published",
    startsAt: new Date("2099-12-04T20:00:00Z"),
    endsAt: new Date("2099-12-04T22:00:00Z"),
    capacity: 100,
    location: "Voice channel",
  });
  return key;
}

async function seedAnswer(db: Db, eventId: number, userId: string, status: string): Promise<void> {
  await db.insert(rsvps).values({ eventId, userId, status });
}

const isMissingRelation = (err: unknown) => (err as { code?: string } | null)?.code === "42P01";

type FixtureClient = MemberDataFixture["client"];

async function seedFollows(
  client: FixtureClient,
  parentId: number,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await client`insert into series_follows (parent_event_id, user_id) select ${parentId}, unnest(${userIds}::text[])`;
  } catch (err) {
    if (isMissingRelation(err)) throw new Error("series_follows table is not implemented yet");
    throw err;
  }
}

async function followUserIds(client: FixtureClient, parentId: number): Promise<string[]> {
  try {
    const rows =
      await client`select user_id from series_follows where parent_event_id = ${parentId} order by created_at, user_id`;
    return rows.map((row) => String(row.user_id));
  } catch (err) {
    if (isMissingRelation(err)) throw new Error("series_follows table is not implemented yet");
    throw err;
  }
}

const answersOn = (db: Db, eventId: number, userId: string) =>
  db
    .select()
    .from(rsvps)
    .where(and(eq(rsvps.eventId, eventId), eq(rsvps.userId, userId)));

async function expectStatus(
  db: Db,
  eventId: number,
  userId: string,
  status: string,
): Promise<void> {
  const rows = await answersOn(db, eventId, userId);
  expect(rows.map((row) => row.status)).toEqual([status]);
}

async function expectNoAnswer(db: Db, eventId: number, userId: string): Promise<void> {
  expect(await answersOn(db, eventId, userId)).toHaveLength(0);
}

type FollowData = { following: boolean; going: number; waitlisted: number; message: string };

const followData = async (res: Response): Promise<FollowData> =>
  ((await res.json()) as { data: FollowData }).data;

describe.skipIf(!process.env.DATABASE_URL)("series follow with publish fan-out (live)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let client: FixtureClient;
  let realPostgres: typeof postgres;
  let env: Env;
  let memberCookie = "";
  let modCookie = "";
  let outsiderCookie = "";
  const store = createMemorySessionStore();
  const sent: unknown[] = [];

  beforeAll(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    client = fixture.client;
    // Create the fixture first: producer clients must be native, not Drizzle's
    // serializer-mutated client, and cannot escape the owned schema or URL guard.
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}> = {}) => {
      const safe = testDatabaseUrl(raw);
      return realPostgres(safe.href, {
        ...opts,
        password: () => safe.password,
        connection: { ...opts.connection, search_path: fixture.schemaName },
      });
    }) as typeof postgres);
    memberCookie = await cookieFor(store, MEMBER);
    modCookie = await cookieFor(store, MODERATOR);
    outsiderCookie = await cookieFor(store, OUTSIDER);
    env = {
      ...baseEnv,
      SESSION_STORE: store,
      ADMIN_DB: db,
      get DB() {
        return { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href };
      },
      SYNC_EVENT_QUEUE: {
        send: async (body: unknown) => {
          sent.push(body);
        },
      },
    } as unknown as Env;
  });
  afterAll(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
    await client`delete from web_throttle_hits`;
    await client`delete from queue_jobs`;
    await client`delete from job_unique_locks`;
    sent.length = 0;
    try {
      await client`delete from series_follows`;
    } catch (err) {
      // Pre-implementation the follow table does not exist yet: nothing to
      // clear. Any other failure is real and must surface.
      if (!isMissingRelation(err)) throw err;
    }
  });

  const headers = (cookie?: string) => ({
    accept: "application/json",
    "content-type": "application/json",
    origin: APP_URL,
    ...(cookie ? { cookie } : {}),
  });
  const putFollow = (key: string, cookie?: string) =>
    app.request(
      `/events/${key}/series/follow`,
      { method: "PUT", headers: headers(cookie), body: "{}" },
      env,
    );
  const deleteFollow = (key: string, cookie?: string) =>
    app.request(
      `/events/${key}/series/follow`,
      { method: "DELETE", headers: headers(cookie) },
      env,
    );
  const putRsvp = (key: string, cookie: string, status = "going") =>
    app.request(
      `/events/${key}/rsvp`,
      { method: "PUT", headers: headers(cookie), body: JSON.stringify({ status }) },
      env,
    );
  const deleteRsvp = (key: string, cookie: string) =>
    app.request(`/events/${key}/rsvp`, { method: "DELETE", headers: headers(cookie) }, env);
  const publish = (key: string) =>
    app.request(
      `/events/${key}/publish`,
      { method: "POST", headers: headers(modCookie), body: "{}" },
      env,
    );
  const cancel = (key: string) =>
    app.request(
      `/events/${key}/cancel`,
      { method: "POST", headers: headers(modCookie), body: "{}" },
      env,
    );

  it("rejects signed-out follow and unfollow", async () => {
    const series = await seedSeries(db, {});
    const put = await putFollow(series.parentKey);
    expect(put.status).toBe(401);
    expect(await put.json()).toMatchObject({ error: "unauthenticated" });
    const del = await deleteFollow(series.parentKey);
    expect(del.status).toBe(401);
  });

  it("rejects non-member follow and unfollow", async () => {
    const series = await seedSeries(db, {});
    const put = await putFollow(series.parentKey, outsiderCookie);
    expect(put.status).toBe(403);
    expect(await put.json()).toMatchObject({ error: "forbidden" });
    const del = await deleteFollow(series.parentKey, outsiderCookie);
    expect(del.status).toBe(403);
  });

  it("answers 404 for unknown keys and non-series events", async () => {
    const missing = await putFollow(freshKey(), memberCookie);
    expect(missing.status).toBe(404);
    const missingDel = await deleteFollow(freshKey(), memberCookie);
    expect(missingDel.status).toBe(404);
    const key = freshKey();
    await db.insert(events).values({
      eventKey: key,
      title: "One-off",
      status: "published",
      startsAt: new Date("2099-11-04T20:00:00Z"),
      endsAt: new Date("2099-11-04T22:00:00Z"),
      capacity: 10,
      location: "Voice channel",
    });
    const ordinary = await putFollow(key, memberCookie);
    expect(ordinary.status).toBe(404);
    expect(await ordinary.json()).toMatchObject({ error: "not_found" });
  });

  it("follow seats upcoming published instances and names going vs waitlisted counts", async () => {
    const series = await seedSeries(db, {
      children: [
        { status: "published" },
        { status: "published", capacity: 1 },
        { status: "draft" },
        { status: "cancelled" },
        {
          status: "published",
          startsAt: "2020-01-06T20:00:00Z",
          endsAt: "2020-01-06T22:00:00Z",
        },
      ],
    });
    const open = at(series.children, 0);
    const full = at(series.children, 1);
    const draft = at(series.children, 2);
    const cancelled = at(series.children, 3);
    const past = at(series.children, 4);
    await seedAnswer(db, full.id, memberActor(1).userId, "going");
    const res = await putFollow(series.parentKey, memberCookie);
    expect(res.status).toBe(201);
    const data = await followData(res);
    expect(data.following).toBe(true);
    expect(data.going).toBe(2);
    expect(data.waitlisted).toBe(1);
    expect(data.message).toMatch(/upcoming nights?/i);
    expect(data.message).toMatch(/waitlist/i);
    expect(data.message).toMatch(/\b2\b/);
    expect(data.message).toMatch(/\b1\b/);
    await expectStatus(db, series.parentId, MEMBER.userId, "going");
    await expectStatus(db, open.id, MEMBER.userId, "going");
    await expectStatus(db, full.id, MEMBER.userId, "waitlisted");
    await expectNoAnswer(db, draft.id, MEMBER.userId);
    await expectNoAnswer(db, cancelled.id, MEMBER.userId);
    await expectNoAnswer(db, past.id, MEMBER.userId);
    expect(await followUserIds(client, series.parentId)).toEqual([MEMBER.userId]);
  });

  it("follow skips answered instances and counts total standing", async () => {
    const series = await seedSeries(db, {
      children: [{ status: "published" }, { status: "published", capacity: 1 }],
    });
    const open = at(series.children, 0);
    const full = at(series.children, 1);
    await seedAnswer(db, full.id, memberActor(1).userId, "going");
    const direct = await putRsvp(open.key, memberCookie, "going");
    expect(direct.status).toBe(201);
    const res = await putFollow(series.parentKey, memberCookie);
    expect(res.status).toBe(201);
    const data = await followData(res);
    expect(data.going).toBe(2);
    expect(data.waitlisted).toBe(1);
    expect(await answersOn(db, open.id, MEMBER.userId)).toHaveLength(1);
  });

  it("follow backfill respects FIFO order onto a full night", async () => {
    const series = await seedSeries(db, {
      children: [{ status: "published", capacity: 1 }],
    });
    const full = at(series.children, 0);
    const first = memberActor(1);
    const second = memberActor(2);
    await seedAnswer(db, full.id, MEMBER.userId, "going");
    const r1 = await putFollow(series.parentKey, await cookieFor(store, first));
    expect(r1.status).toBe(201);
    const r2 = await putFollow(series.parentKey, await cookieFor(store, second));
    expect(r2.status).toBe(201);
    await expectStatus(db, full.id, first.userId, "waitlisted");
    await expectStatus(db, full.id, second.userId, "waitlisted");
    const rows = await db.select().from(rsvps).where(eq(rsvps.eventId, full.id));
    const created = new Map(rows.map((row) => [row.userId, row.createdAt.getTime()]));
    const firstAt = created.get(first.userId);
    const secondAt = created.get(second.userId);
    if (firstAt === undefined || secondAt === undefined)
      throw new Error("waitlist rows missing after follow backfill");
    expect(firstAt).toBeLessThan(secondAt);
  });

  it("follow with no upcoming published nights stores the follow for later publishes", async () => {
    const series = await seedSeries(db, {
      parentStatus: "draft",
      children: [{ status: "draft" }],
    });
    const res = await putFollow(series.parentKey, memberCookie);
    expect(res.status).toBe(201);
    const data = await followData(res);
    expect(data.following).toBe(true);
    expect(data.going).toBe(0);
    expect(data.waitlisted).toBe(0);
    expect(await followUserIds(client, series.parentId)).toEqual([MEMBER.userId]);
    const published = await publish(series.parentKey);
    expect(published.status).toBe(200);
    await expectStatus(db, series.parentId, MEMBER.userId, "going");
  });

  it("re-follow while following never re-seats a withdrawn night", async () => {
    const series = await seedSeries(db, { children: [{ status: "published" }] });
    const night = at(series.children, 0);
    const first = await putFollow(series.parentKey, memberCookie);
    expect(first.status).toBe(201);
    const withdrawn = await deleteRsvp(night.key, memberCookie);
    expect(withdrawn.status).toBe(204);
    const again = await putFollow(series.parentKey, memberCookie);
    expect(again.status).toBe(200);
    const data = await followData(again);
    expect(data.following).toBe(true);
    expect(data.going).toBe(1);
    expect(data.waitlisted).toBe(0);
    await expectNoAnswer(db, night.id, MEMBER.userId);
    expect(await followUserIds(client, series.parentId)).toEqual([MEMBER.userId]);
  });

  it("follow after unfollow backfills answer-less nights again", async () => {
    const series = await seedSeries(db, { children: [{ status: "published" }] });
    const night = at(series.children, 0);
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    expect((await deleteFollow(series.parentKey, memberCookie)).status).toBe(204);
    const withdrawn = await deleteRsvp(night.key, memberCookie);
    expect(withdrawn.status).toBe(204);
    const again = await putFollow(series.parentKey, memberCookie);
    expect(again.status).toBe(201);
    await expectStatus(db, night.id, MEMBER.userId, "going");
    await expectStatus(db, series.parentId, MEMBER.userId, "going");
  });

  it("publishing a later instance seats followers in that publish", async () => {
    const series = await seedSeries(db, {
      parentStatus: "draft",
      children: [{ status: "draft" }],
    });
    const night = at(series.children, 0);
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    await expectNoAnswer(db, night.id, MEMBER.userId);
    const published = await publish(night.key);
    expect(published.status).toBe(200);
    await expectStatus(db, night.id, MEMBER.userId, "going");
  });

  it("publish fan-out seats in follow order and waitlists past capacity", async () => {
    const series = await seedSeries(db, {
      parentStatus: "draft",
      children: [{ status: "draft", capacity: 1 }],
    });
    const night = at(series.children, 0);
    const first = memberActor(1);
    const second = memberActor(2);
    expect((await putFollow(series.parentKey, await cookieFor(store, first))).status).toBe(201);
    expect((await putFollow(series.parentKey, await cookieFor(store, second))).status).toBe(201);
    const published = await publish(night.key);
    expect(published.status).toBe(200);
    await expectStatus(db, night.id, first.userId, "going");
    await expectStatus(db, night.id, second.userId, "waitlisted");
  });

  it("publish fan-out seats followers with an exhausted throttle budget", async () => {
    const series = await seedSeries(db, {
      parentStatus: "draft",
      children: [{ status: "draft" }],
    });
    const night = at(series.children, 0);
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    const sink = await seedSinkEvent(db);
    for (let i = 0; i < 11; i++) {
      const res = await putRsvp(sink, memberCookie, "going");
      expect(res.status).toBeLessThan(300);
    }
    const limited = await putRsvp(sink, memberCookie, "going");
    expect(limited.status).toBe(429);
    const published = await publish(night.key);
    expect(published.status).toBe(200);
    await expectStatus(db, night.id, MEMBER.userId, "going");
  });

  it("withdraw-after-follow sticks when a later instance publishes", async () => {
    const series = await seedSeries(db, {
      children: [{ status: "published" }, { status: "draft" }],
    });
    const open = at(series.children, 0);
    const later = at(series.children, 1);
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    expect((await deleteRsvp(open.key, memberCookie)).status).toBe(204);
    expect((await publish(later.key)).status).toBe(200);
    await expectNoAnswer(db, open.id, MEMBER.userId);
    await expectStatus(db, later.id, MEMBER.userId, "going");
  });

  it("unfollow keeps existing answers and stops future fan-out", async () => {
    const series = await seedSeries(db, {
      children: [{ status: "published", capacity: 1 }, { status: "draft" }],
    });
    const full = at(series.children, 0);
    const later = at(series.children, 1);
    await seedAnswer(db, full.id, memberActor(1).userId, "going");
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    await expectStatus(db, full.id, MEMBER.userId, "waitlisted");
    expect((await deleteFollow(series.parentKey, memberCookie)).status).toBe(204);
    await expectStatus(db, full.id, MEMBER.userId, "waitlisted");
    await expectStatus(db, series.parentId, MEMBER.userId, "going");
    expect(await followUserIds(client, series.parentId)).toEqual([]);
    expect((await deleteFollow(series.parentKey, memberCookie)).status).toBe(404);
    expect((await publish(later.key)).status).toBe(200);
    await expectNoAnswer(db, later.id, MEMBER.userId);
  });

  it("cancel-to-re-publish re-applies follow only to followers with no answer", async () => {
    const series = await seedSeries(db, { children: [{ status: "published" }] });
    const night = at(series.children, 0);
    const keeper = memberActor(1);
    const keeperCookie = await cookieFor(store, keeper);
    const stranger = memberActor(2);
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    expect((await putFollow(series.parentKey, keeperCookie)).status).toBe(201);
    const maybe = await putRsvp(night.key, keeperCookie, "maybe");
    expect(maybe.status).toBe(200);
    expect((await deleteRsvp(night.key, memberCookie)).status).toBe(204);
    expect((await cancel(night.key)).status).toBe(200);
    const republished = await publish(night.key);
    expect(republished.status).toBe(200);
    await expectStatus(db, night.id, MEMBER.userId, "going");
    await expectStatus(db, night.id, keeper.userId, "maybe");
    await expectNoAnswer(db, night.id, stranger.userId);
  });

  it("refuses the 501st follower atomically with plain copy", async () => {
    const series = await seedSeries(db, { children: [{ status: "published" }] });
    const night = at(series.children, 0);
    await seedFollows(
      client,
      series.parentId,
      Array.from({ length: 499 }, (_, i) => `cap-seed-${i}`),
    );
    const fiveHundredth = await putFollow(series.parentKey, memberCookie);
    expect(fiveHundredth.status).toBe(201);
    const extra = memberActor(1);
    const refused = await putFollow(series.parentKey, await cookieFor(store, extra));
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error?: string; message?: string };
    expect(body.error).toBe("series_full");
    expect(body.message ?? "").toMatch(/500/);
    expect(await followUserIds(client, series.parentId)).toHaveLength(500);
    await expectNoAnswer(db, series.parentId, extra.userId);
    await expectNoAnswer(db, night.id, extra.userId);
  });

  it("applies the follower cap per series", async () => {
    const full = await seedSeries(db, {});
    const other = await seedSeries(db, {});
    await seedFollows(
      client,
      full.parentId,
      Array.from({ length: 500 }, (_, i) => `cap-seed-${i}`),
    );
    const res = await putFollow(other.parentKey, memberCookie);
    expect(res.status).toBe(201);
  });

  it("follow shares the member RSVP write budget", async () => {
    const series = await seedSeries(db, {});
    const sink = await seedSinkEvent(db);
    for (let i = 0; i < 12; i++) {
      const res = await putRsvp(sink, memberCookie, "going");
      expect(res.status).toBeLessThan(300);
    }
    const refused = await putFollow(series.parentKey, memberCookie);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).not.toBeNull();
    expect(await followUserIds(client, series.parentId)).toEqual([]);
  });

  it("follow spends a single shared attempt however many nights it seats", async () => {
    const series = await seedSeries(db, {
      children: [{ status: "published" }, { status: "published" }],
    });
    const sink = await seedSinkEvent(db);
    const followed = await putFollow(series.parentKey, memberCookie);
    expect(followed.status).toBe(201);
    const data = await followData(followed);
    expect(data.going).toBe(3);
    for (let i = 0; i < 11; i++) {
      const res = await putRsvp(sink, memberCookie, "going");
      expect(res.status).toBeLessThan(300);
    }
    const refused = await putRsvp(sink, memberCookie, "going");
    expect(refused.status).toBe(429);
  });

  it("unfollow spends a single shared attempt", async () => {
    const series = await seedSeries(db, {});
    const sink = await seedSinkEvent(db);
    expect((await putFollow(series.parentKey, memberCookie)).status).toBe(201);
    for (let i = 0; i < 10; i++) {
      const res = await putRsvp(sink, memberCookie, "going");
      expect(res.status).toBeLessThan(300);
    }
    expect((await deleteFollow(series.parentKey, memberCookie)).status).toBe(204);
    const refused = await putRsvp(sink, memberCookie, "going");
    expect(refused.status).toBe(429);
  });

  it("publishes a followed instance promptly (timing guardrail)", async () => {
    const series = await seedSeries(db, {
      parentStatus: "draft",
      children: [{ status: "draft", capacity: 100 }],
    });
    const night = at(series.children, 0);
    await seedFollows(
      client,
      series.parentId,
      Array.from({ length: 30 }, (_, i) => `fanout-${i}`),
    );
    const start = Date.now();
    const published = await publish(night.key);
    expect(published.status).toBe(200);
    for (let i = 0; i < 30; i++) {
      await expectStatus(db, night.id, `fanout-${i}`, "going");
    }
    // Generous guardrail, not a budget: the build change notes the measured
    // publish-transaction timing in its PR body.
    expect(Date.now() - start).toBeLessThan(30_000);
  });
});

describe("series follow fan-out set (unit)", () => {
  type SeriesFollowModule = {
    SERIES_FOLLOWER_CAP: number;
    computeFanoutTargets: (followers: readonly string[], answered: readonly string[]) => string[];
  };
  // Resolved through a variable on purpose: a literal import of a module that
  // does not exist yet would fail typecheck instead of failing these tests.
  const MODULE_PATH = "../src/events/series-follow";
  const loadModule = async (): Promise<SeriesFollowModule> => {
    let mod: Partial<SeriesFollowModule> | null = null;
    try {
      mod = (await import(/* @vite-ignore */ MODULE_PATH)) as Partial<SeriesFollowModule>;
    } catch {
      mod = null;
    }
    expect(mod, "series follow module must exist at src/events/series-follow.ts").not.toBeNull();
    if (!mod) throw new Error("unreachable: series follow module missing after null check");
    expect(typeof mod.computeFanoutTargets, "computeFanoutTargets must be exported").toBe(
      "function",
    );
    return mod as SeriesFollowModule;
  };

  it("caps a series at 500 followers", async () => {
    const mod = await loadModule();
    expect(mod.SERIES_FOLLOWER_CAP).toBe(500);
  });

  it("seats followers holding no answer, skipping the answered", async () => {
    const mod = await loadModule();
    expect(mod.computeFanoutTargets(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  it("preserves follow order for FIFO seating", async () => {
    const mod = await loadModule();
    expect(mod.computeFanoutTargets(["first", "second", "third"], [])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("seats nobody when every follower already answered", async () => {
    const mod = await loadModule();
    expect(mod.computeFanoutTargets(["a", "b"], ["a", "b", "c"])).toEqual([]);
  });

  it("seats nobody without followers", async () => {
    const mod = await loadModule();
    expect(mod.computeFanoutTargets([], ["a"])).toEqual([]);
  });
});
