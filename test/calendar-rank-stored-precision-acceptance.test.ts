// Acceptance: the day-jump rank must use the stored timestamp precision,
// not a JS Date round-trip. PostgreSQL keeps microseconds a JS Date drops,
// so events sharing one microsecond start (or differing only below one
// millisecond) at a page boundary must still rank exactly where the list
// order (`startsAt`, then `id`) puts them — otherwise the jump selects a
// page that does not hold the requested card. Real reads and the real
// route against the isolated test database only. Fixtures insert SQL
// timestamp strings, never JS Dates, so the stored microseconds survive.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { listUpcoming, rankUpcoming } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { EVENTS_UPCOMING_PAGE_SIZE } from "../src/islands/contracts";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;

const NOW = new Date("2060-06-01T00:00:00Z");

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

const key = (n: number) => `01P${String(n).padStart(23, "0")}`;

type FixtureClient = Awaited<ReturnType<typeof createMemberDataFixture>>["client"];

// Sequential awaited inserts keep `id` ascending in call order, which is
// the list tiebreak for equal stored starts.
async function seedRow(
  client: FixtureClient,
  n: number,
  startsAt: string,
  endsAt: string,
  status = "published",
  title = `Micro ${n}`,
): Promise<void> {
  await client`insert into events (event_key, title, starts_at, ends_at, status)
    values (${key(n)}, ${title}, ${startsAt}::timestamptz, ${endsAt}::timestamptz, ${status})`;
}

async function seedSharedStart(
  client: FixtureClient,
  count: number,
  startsAt: string,
  endsAt: string,
): Promise<void> {
  for (let i = 0; i < count; i++) await seedRow(client, i, startsAt, endsAt);
}

const MICRO_STARTS = "2060-07-01T18:00:00.123456Z";
const MICRO_ENDS = "2060-07-01T20:00:00.123456Z";
const MILLI_STARTS = "2060-07-01T18:00:00.123Z";
const MILLI_ENDS = "2060-07-01T20:00:00.123Z";

describe.skipIf(!url)("upcoming rank at stored precision (isolated test DB)", () => {
  it("ranks a shared microsecond start by id, agreeing with the list order", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      const total = EVENTS_UPCOMING_PAGE_SIZE + 5;
      await seedSharedStart(client, total, MICRO_STARTS, MICRO_ENDS);

      // The fixture really stored six fractional digits; a JS Date fixture
      // could not, which would make every assertion below vacuous.
      const [stored] =
        await client`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as starts
        from events where event_key = ${key(0)}`;
      expect(stored?.starts).toBe("2060-07-01T18:00:00.123456");

      // Positive control: the list itself already orders at stored
      // precision — equal starts fall back to id across the page boundary.
      const first = await listUpcoming(db, NOW, {}, 1);
      const second = await listUpcoming(db, NOW, {}, 2);
      expect(first.rows).toHaveLength(EVENTS_UPCOMING_PAGE_SIZE);
      expect(second.rows).toHaveLength(5);
      const listed = [...first.rows, ...second.rows].map((row) => row.eventKey);
      expect(listed).toEqual(Array.from({ length: total }, (_, i) => key(i)));

      // Every rank must equal the position the list gave that key, in
      // particular the first card past the page boundary and the last card.
      for (let i = 0; i < total; i++) {
        expect(await rankUpcoming(db, key(i), NOW)).toBe(i);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("ranks distinct microsecond starts within one millisecond before the id tiebreak", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      // Insertion (id) order deliberately disagrees with stored order:
      // all four starts share one JS millisecond (.123), so only the
      // stored microseconds can produce the list order pinned below.
      await seedRow(client, 0, "2060-07-01T18:00:00.123999Z", MICRO_ENDS);
      await seedRow(client, 1, "2060-07-01T18:00:00.123111Z", MICRO_ENDS);
      await seedRow(client, 2, "2060-07-01T18:00:00.123555Z", MICRO_ENDS);
      await seedRow(client, 3, "2060-07-01T18:00:00.123111Z", MICRO_ENDS);

      const { rows } = await listUpcoming(db, NOW, {}, 1);
      expect(rows.map((row) => row.eventKey)).toEqual([key(1), key(3), key(2), key(0)]);

      expect(await rankUpcoming(db, key(1), NOW)).toBe(0);
      expect(await rankUpcoming(db, key(3), NOW)).toBe(1);
      expect(await rankUpcoming(db, key(2), NOW)).toBe(2);
      expect(await rankUpcoming(db, key(0), NOW)).toBe(3);
    } finally {
      await fixture.dispose();
    }
  });

  it("resolves a day-jump across the page boundary for a shared microsecond start", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedSharedStart(client, EVENTS_UPCOMING_PAGE_SIZE + 5, MICRO_STARTS, MICRO_ENDS);
      const application = app();

      // The first card of page two and the last card overall: the selected
      // page must actually contain the requested card.
      for (const target of [key(EVENTS_UPCOMING_PAGE_SIZE), key(EVENTS_UPCOMING_PAGE_SIZE + 4)]) {
        const jumped = await application.request(`/events?event=${target}`, {}, routeEnv(db));
        expect(jumped.status).toBe(200);
        const html = await jumped.text();
        expect(html).toContain("Page 2 of 2.");
        expect(html).toContain(`id="event-${target}"`);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("control: ranks a millisecond-exact shared start by id and jumps to page two", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      const total = EVENTS_UPCOMING_PAGE_SIZE + 5;
      await seedSharedStart(client, total, MILLI_STARTS, MILLI_ENDS);

      for (let i = 0; i < total; i++) {
        expect(await rankUpcoming(db, key(i), NOW)).toBe(i);
      }

      const target = key(EVENTS_UPCOMING_PAGE_SIZE);
      const jumped = await app().request(`/events?event=${target}`, {}, routeEnv(db));
      expect(jumped.status).toBe(200);
      const html = await jumped.text();
      expect(html).toContain("Page 2 of 2.");
      expect(html).toContain(`id="event-${target}"`);
    } finally {
      await fixture.dispose();
    }
  });

  it("control: keeps draft, ended, absent and unrenderable keys out of the rank", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      // Millisecond-exact timestamps keep this control about visibility
      // filtering alone, independent of the precision behavior above.
      await seedRow(client, 0, MILLI_STARTS, MILLI_ENDS, "published", "Anchor alpha");
      await seedRow(client, 1, MILLI_STARTS, MILLI_ENDS, "draft", "Anchor draft");
      await seedRow(client, 2, MILLI_STARTS, MILLI_ENDS, "published", "Anchor beta");
      await seedRow(
        client,
        3,
        "2060-05-01T18:00:00.123Z",
        "2060-05-01T20:00:00.123Z",
        "published",
        "Anchor ended",
      );
      // Finite in PostgreSQL but outside the JS Date range: refused as
      // unrenderable, and it sorts after every anchor above.
      await seedRow(
        client,
        4,
        "280000-06-01T18:00:00Z",
        "280000-06-01T20:00:00Z",
        "published",
        "Anchor far",
      );

      // Anonymous rank: the draft neither counts nor resolves.
      expect(await rankUpcoming(db, key(0), NOW)).toBe(0);
      expect(await rankUpcoming(db, key(2), NOW)).toBe(1);
      expect(await rankUpcoming(db, key(1), NOW)).toBeNull();
      // With drafts included the same rows shift by the one draft.
      expect(await rankUpcoming(db, key(1), NOW, { includeDrafts: true })).toBe(1);
      expect(await rankUpcoming(db, key(2), NOW, { includeDrafts: true })).toBe(2);
      // Ended, unrenderable and absent keys never resolve to a page.
      expect(await rankUpcoming(db, key(3), NOW)).toBeNull();
      expect(await rankUpcoming(db, key(4), NOW)).toBeNull();
      expect(await rankUpcoming(db, key(99), NOW)).toBeNull();
      // A search that matches only the target ranks it first; a search
      // that excludes the target nulls it.
      expect(await rankUpcoming(db, key(2), NOW, { search: "beta" })).toBe(0);
      expect(await rankUpcoming(db, key(2), NOW, { search: "alpha" })).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});
