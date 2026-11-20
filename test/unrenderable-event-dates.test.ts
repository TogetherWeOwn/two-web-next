// Staging regression (TOG-11700): PostgreSQL accepts finite timestamps far
// outside the JS Date range (up to year 294276, e.g. legacy imports); the
// driver decodes those to invalid Dates whose `toISOString()`/formatting
// throws RangeError, which 500s /events and /e/:key even though #232's
// `isfinite()` guard passes them (feeds don't throw — they serve corrupt
// `NaN` instants as 200, also refused here). Served reads refuse such
// windows the same way 404 suggestions and related links already do. The
// write path caps years at four digits, so only imports can carry such rows.
// Isolated test DB only.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Env } from "../src/env";
import { events } from "../src/db/admin-schema";
import {
  getEventRow,
  getPublicEvent,
  listCalendarPast,
  listFeed,
  listHomeUpcoming,
  listJson,
  listPast,
  listUpcoming,
} from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;

// 26-char Crockford ULIDs: the /e/:key and /events/:file.ics routes 404
// anything shorter via KEY_RE before any read runs, which would fake the
// single/export assertions green.
const key = (n: number) => String(n).padStart(26, "0");
const FINITE = key(101);
const FAR_BOTH = key(102);
const FAR_END = key(103);
const NEVER_INSERTED = key(109);

const FAR_STARTS = "280000-06-01T18:00:00Z";
const FAR_ENDS = "280000-06-01T20:00:00Z";

const routeEnv = (adminDb: EnvWithAdminDb["ADMIN_DB"]) =>
  ({
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "fixture",
    DISCORD_CLIENT_SECRET: "fixture",
    DISCORD_GUILD_ID: "fixture",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    DISCORD_BOT_TOKEN: "fixture",
    SESSION_SECRET: "fixture",
    ADMIN_DB: adminDb,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  }) as unknown as Env;

const app = () => {
  const application = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    application,
    async () => null,
    async () => null,
  );
  return application;
};

describe.skipIf(!url)("served reads refuse JS-unrepresentable windows (isolated test DB)", () => {
  it("refills homepage slots when finite PostgreSQL ends overflow JavaScript Dates", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status) values
        ('overflow-1', 'Overflow 1', '2069-01-02T18:00:00Z', ${FAR_ENDS}, 'published'),
        ('overflow-2', 'Overflow 2', '2069-01-03T18:00:00Z', ${FAR_ENDS}, 'published'),
        ('overflow-3', 'Overflow 3', '2069-01-04T18:00:00Z', ${FAR_ENDS}, 'published'),
        ('later-valid', 'Later valid', '2069-01-06T18:00:00Z', '2069-01-06T20:00:00Z', 'published')`;
      const raw =
        await client`select isfinite(ends_at) as finite from events where event_key = 'overflow-1'`;
      expect(raw[0]!.finite).toBe(true);
      const decoded = await db.select().from(events);
      expect(
        Number.isNaN(decoded.find((row) => row.eventKey === "overflow-1")!.endsAt.getTime()),
      ).toBe(true);
      const home = await listHomeUpcoming(db, new Date("2069-01-01T00:00:00Z"));
      expect(home.map((row) => row.eventKey)).toEqual(["later-valid"]);
    } finally {
      await fixture.dispose();
    }
  });

  it("matches decoded homepage window boundaries before the limit", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      // Keep the end upcoming even for the BC start. Check the driver's actual
      // decoding as well as admission, including sub-millisecond precision.
      for (const [start, end, valid] of [
        ["0001-12-31 23:59:59+00 BC", "2069-01-02T20:00:00Z", false],
        ["0001-01-01 00:00:00+00", "2069-01-02T20:00:00Z", true],
        ["2069-01-02T18:00:00Z", "275760-09-13 00:00:00.000999+00", true],
        ["2069-01-02T18:00:00Z", "275760-09-13 00:00:00.001+00", false],
        ["275760-09-13 00:00:00.000999+00", "275760-09-13 00:00:00.000999+00", true],
        ["275760-09-13 00:00:00.001+00", "275760-09-13 00:00:00.001+00", false],
      ] as const) {
        await client`delete from events`;
        await client`insert into events (event_key, title, starts_at, ends_at, status)
          values ('boundary', 'Boundary', ${start}::timestamptz, ${end}::timestamptz, 'published')`;
        const [row] = await db.select().from(events);
        const decoded =
          Number.isFinite(row!.startsAt.getTime()) && Number.isFinite(row!.endsAt.getTime());
        expect(decoded, `${start} / ${end}`).toBe(valid);
        const home = await listHomeUpcoming(db, new Date("2069-01-01T00:00:00Z"));
        expect(
          home.map((event) => event.eventKey),
          `${start} / ${end}`,
        ).toEqual(valid ? ["boundary"] : []);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("excludes far-future windows from listFeed, listUpcoming and listHomeUpcoming", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values
          (${FINITE}, 'Finite upcoming', '2070-01-01T18:00:00Z', '2070-01-01T20:00:00Z', 'published'),
          (${FAR_BOTH}, 'Far both', ${FAR_STARTS}, ${FAR_ENDS}, 'published'),
          (${FAR_END}, 'Far end', '2070-03-01T18:00:00Z', ${FAR_ENDS}, 'published')`;

      const feed = await listFeed(db, ["published", "cancelled"]);
      expect(feed.map((row) => row.eventKey)).toEqual([FINITE]);
      const { rows: upcoming, total } = await listUpcoming(db);
      expect(upcoming.map((row) => row.eventKey)).toEqual([FINITE]);
      // Like the past archive, the total still counts the JS-refused rows so
      // page boundaries stay stable while they drop out of the render.
      expect(total).toBe(3);
      const home = await listHomeUpcoming(db);
      expect(home.map((row) => row.eventKey)).toEqual([FINITE]);
    } finally {
      await fixture.dispose();
    }
  });

  it("nulls unrenderable single and per-event lookups instead of serving them", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values
          (${FINITE}, 'Finite upcoming', '2070-01-01T18:00:00Z', '2070-01-01T20:00:00Z', 'published'),
          (${FAR_BOTH}, 'Far both', ${FAR_STARTS}, ${FAR_ENDS}, 'published')`;

      expect((await getPublicEvent(db, FINITE))?.eventKey).toBe(FINITE);
      expect(await getPublicEvent(db, FAR_BOTH)).toBeNull();
      expect((await getEventRow(db, FINITE))?.eventKey).toBe(FINITE);
      expect(await getEventRow(db, FAR_BOTH)).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("serves the calendar page and both feeds without NaN bytes when only far-future rows exist", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values
          (${FAR_BOTH}, 'Far both', ${FAR_STARTS}, ${FAR_ENDS}, 'published'),
          (${FAR_END}, 'Far end', '2070-03-01T18:00:00Z', ${FAR_ENDS}, 'published')`;

      const application = app();
      for (const path of ["/events", "/events.rss", "/events.ics"]) {
        const response = await application.request(path, {}, routeEnv(db));
        const body = await response.text();
        expect([path, response.status]).toEqual([path, 200]);
        expect(body).not.toContain("Far both");
        expect(body).not.toContain("Far end");
        expect(body).not.toContain("NaN");
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses far-future windows in the past drawer, archive and member JSON", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      // An ended row with an unrenderable starts_at is archived (ends_at <
      // now) yet unrenderable — both the drawer and the archive `Card` render
      // `startsAt` unguarded, as does the member JSON serializer.
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values
          (${FINITE}, 'Finite past', '2020-01-01T18:00:00Z', '2020-01-01T20:00:00Z', 'published'),
          (${FAR_BOTH}, 'Far past', ${FAR_STARTS}, '2020-06-01T20:00:00Z', 'published')`;

      const drawer = await listCalendarPast(db);
      expect(drawer.map((row) => row.eventKey)).toEqual([FINITE]);
      const archive = await listPast(db, 1);
      expect(archive.rows.map((row) => row.eventKey)).toEqual([FINITE]);
      const json = await listJson(db, { limit: 20, offset: 0 });
      expect(json.rows.map((row) => row.eventKey)).toEqual([FINITE]);

      // The pages themselves stay 200 with only the poison row archived.
      await client`delete from events where event_key = ${FINITE}`;
      const application = app();
      const env = routeEnv(db);
      const past = await application.request("/events/past", {}, env);
      expect(past.status).toBe(200);
      expect(await past.text()).not.toContain("NaN");
      const page = await application.request("/events", {}, env);
      expect(page.status).toBe(200);
      expect(await page.text()).not.toContain("NaN");
    } finally {
      await fixture.dispose();
    }
  });

  it("404s the event page and per-event export for far-future rows without 500ing", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values (${FAR_BOTH}, 'Far both', ${FAR_STARTS}, ${FAR_ENDS}, 'published')`;

      const application = app();
      const env = routeEnv(db);
      expect((await application.request(`/e/${FAR_BOTH}`, {}, env)).status).toBe(404);
      expect((await application.request(`/events/${FAR_BOTH}.ics`, {}, env)).status).toBe(404);
      expect((await application.request(`/e/${NEVER_INSERTED}`, {}, env)).status).toBe(404);
    } finally {
      await fixture.dispose();
    }
  });
});
