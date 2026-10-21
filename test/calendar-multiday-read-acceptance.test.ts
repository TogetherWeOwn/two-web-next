// Canonical interval admission, independent of the render fixtures. February
// 2027 is exactly four Monday–Sunday weeks (Feb 1–28). All SQL lives in an
// owned disposable schema; no live event source or production/staging DB.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminSchema, schema } from "../src/db/index";
import { listUpcoming, listUpcomingForMonth } from "../src/events/reads";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;
const NOW = new Date("2027-01-15T12:00:00Z");

describe.skipIf(!url)("canonical multi-day month reads (disposable DB)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let statements: string[] = [];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!);
    db = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: { logQuery: (query) => void statements.push(query) },
    });
  });
  beforeEach(async () => {
    await fixture.reset();
    statements = [];
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  async function seed(
    key: string,
    start: string,
    end: string,
    status = "published",
    timezone = "UTC",
  ) {
    const [row] = await fixture.client<{ id: number }[]>`
      insert into events (event_key, title, starts_at, ends_at, status, timezone)
      values (${key}, ${key}, ${start}, ${end}, ${status}, ${timezone}) returning id`;
    return row!.id;
  }

  it("admits overlap from before the leading week, but not disjoint intervals", async () => {
    await seed("left-disjoint", "2027-01-20T12:00Z", "2027-01-29T12:00Z");
    await seed("before-grid", "2027-01-20T12:00Z", "2027-02-03T12:00Z");
    await seed("in-grid", "2027-02-15T12:00Z", "2027-02-15T14:00Z");
    await seed("through-right", "2027-02-28T23:00Z", "2027-03-04T12:00Z");
    await seed("right-disjoint", "2027-03-03T12:00Z", "2027-03-04T12:00Z");

    const rows = await listUpcomingForMonth(db, "2027-02", NOW);
    expect(rows.map((row) => row.eventKey)).toEqual(["before-grid", "in-grid", "through-right"]);
  });

  it("keeps an already-started ongoing interval, without creating a past archive", async () => {
    await seed("ongoing", "2027-01-20T12:00Z", "2027-02-04T12:00Z");
    await seed("already-ended", "2027-01-20T12:00Z", "2027-02-01T12:00Z");
    await seed("past-status", "2027-01-20T12:00Z", "2027-02-04T12:00Z", "past");
    const now = new Date("2027-02-02T12:00Z");
    expect((await listUpcomingForMonth(db, "2027-02", now)).map((row) => row.eventKey)).toEqual([
      "ongoing",
    ]);
    expect((await listUpcoming(db, now)).rows.map((row) => row.eventKey)).toEqual(["ongoing"]);
  });

  it("admits a very old finite start only when its scheduled end still overlaps", async () => {
    await seed("long-ongoing", "0100-01-01T12:00Z", "9999-12-01T12:00Z");
    await seed("long-disjoint", "0100-01-01T12:00Z", "2027-01-20T12:00Z");
    expect((await listUpcomingForMonth(db, "2027-02", NOW)).map((row) => row.eventKey)).toEqual([
      "long-ongoing",
    ]);
  });

  it("preserves visibility and finite-window defenses before applying the row cap", async () => {
    for (const status of ["draft", "cancelled", "past"])
      await seed(status, "2027-01-20T12:00Z", "2027-02-05T12:00Z", status);
    await seed("negative-infinite-start", "-infinity", "2027-02-05T12:00Z");
    await seed("positive-infinite-start", "infinity", "infinity");
    // Enough early-sorting invalid ends to exhaust the existing 200-row cap
    // if filtering happens after LIMIT or after deserializing Date values.
    await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'infinite-end-' || n, 'Invalid end', '2027-02-01T12:00Z'::timestamptz,
        'infinity'::timestamptz, 'published' from generate_series(1, 205) as n`;
    await seed("finite-visible", "2027-02-15T12:00Z", "2027-02-15T14:00Z");
    expect((await listUpcomingForMonth(db, "2027-02", NOW)).map((row) => row.eventKey)).toEqual([
      "finite-visible",
    ]);
  });

  it("keeps the 200-row bound and three batched statements at both collection sizes", async () => {
    const firstId = await seed("cap-000", "2027-02-15T12:00Z", "2027-02-16T12:00Z");
    await fixture.client`insert into users (id, username) values ('named-going', 'Going')`;
    await fixture.client`insert into rsvps (event_id, user_id, status) values
      (${firstId}, 'named-going', 'going'),
      (${firstId}, 'nameless-going', 'going'),
      (${firstId}, 'maybe', 'maybe'),
      (${firstId}, 'waitlisted', 'waitlisted')`;
    statements = [];
    const small = await listUpcomingForMonth(db, "2027-02", NOW);
    expect(small).toHaveLength(1);
    expect(small[0]!.goingCount).toBe(1);
    expect(statements).toHaveLength(3);
    await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'cap-' || lpad(n::text, 3, '0'), 'Bounded interval',
        '2027-02-15T12:00Z'::timestamptz, '2027-02-16T12:00Z'::timestamptz,
        'published' from generate_series(1, 240) as n`;
    statements = [];
    const large = await listUpcomingForMonth(db, "2027-02", NOW);
    expect(large.map((row) => row.eventKey)).toEqual(
      Array.from({ length: 200 }, (_, n) => `cap-${String(n).padStart(3, "0")}`),
    );
    expect(large[0]!.goingCount).toBe(1);
    expect(large.slice(1).every((row) => row.goingCount === 0)).toBe(true);
    expect(statements).toHaveLength(3);
  });

  it("applies the same row and statement bounds when every admitted interval starts before the grid", async () => {
    await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'overlap-' || lpad(n::text, 3, '0'), 'Long bounded interval',
        '2027-01-20T12:00Z'::timestamptz, '2027-02-16T12:00Z'::timestamptz,
        'published' from generate_series(0, 240) as n`;
    const rows = await listUpcomingForMonth(db, "2027-02", NOW);
    expect(rows.map((row) => row.eventKey)).toEqual(
      Array.from({ length: 200 }, (_, n) => `overlap-${String(n).padStart(3, "0")}`),
    );
    expect(statements).toHaveLength(3);
  });

  it.each(["banana", "0000-01", "10000-01", "2027-13"])(
    "refuses malformed/out-of-bounds month %s without a database read",
    async (month) => {
      expect(await listUpcomingForMonth(db, month, NOW)).toEqual([]);
      expect(statements).toHaveLength(0);
    },
  );
});
