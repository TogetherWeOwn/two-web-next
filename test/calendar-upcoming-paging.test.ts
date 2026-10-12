// The upcoming calendar list is paged and the month grid reads only its
// covered weeks, so the read, the RSVP aggregate and the rendered HTML stay
// bounded no matter how many future events exist. Real route + real SQL
// against the isolated test database only.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { eventSearchLogs } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  listUpcoming,
  listUpcomingForMonth,
  normalizeUpcomingPage,
  rankUpcoming,
} from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import {
  calendarGridRange,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
  EVENTS_UPCOMING_PAGE_SIZE,
} from "../src/islands/contracts";
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

async function seedUpcoming(
  client: FixtureClient,
  base: number,
  count: number,
  firstStartsAt: Date,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const n = base + i;
    const startsAt = new Date(firstStartsAt.getTime() + i * 3600000);
    const endsAt = new Date(startsAt.getTime() + 7200000);
    await client`insert into events (event_key, title, starts_at, ends_at, status)
      values (${key(n)}, ${`Paged ${n}`}, ${startsAt.toISOString()}, ${endsAt.toISOString()}, 'published')`;
  }
}

const cards = (html: string): string[] =>
  [...html.matchAll(/data-testid="event-card"/g)].map((m) => m[0]);

describe("upcoming page numbers", () => {
  it("falls back to page one for invalid input", () => {
    expect(normalizeUpcomingPage(2)).toBe(2);
    expect(normalizeUpcomingPage(0)).toBe(1);
    expect(normalizeUpcomingPage(-3)).toBe(1);
    expect(normalizeUpcomingPage(Number.NaN)).toBe(1);
    expect(normalizeUpcomingPage(Number.parseInt("banana", 10))).toBe(1);
    // Overflow: the offset would stop being a safe integer, like the archive.
    expect(normalizeUpcomingPage(5000000000000000)).toBe(1);
  });
});

describe.skipIf(!url)("upcoming list paging (isolated test DB)", () => {
  it("reads one bounded page at a time with stable order across pages", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      const first = await listUpcoming(db, NOW, {}, 1);
      expect(first.rows).toHaveLength(EVENTS_UPCOMING_PAGE_SIZE);
      expect(first.hasMore).toBe(true);
      expect(first.totalPages).toBe(2);
      expect(first.total).toBe(EVENTS_UPCOMING_PAGE_SIZE + 5);
      const second = await listUpcoming(db, NOW, {}, 2);
      expect(second.rows).toHaveLength(5);
      expect(second.hasMore).toBe(false);
      // Soonest first with no overlap and no gaps across the page boundary.
      const keys = [...first.rows, ...second.rows].map((row) => row.eventKey);
      expect(keys).toEqual(Array.from({ length: EVENTS_UPCOMING_PAGE_SIZE + 5 }, (_, i) => key(i)));
      // Growing the collection past another page keeps page one bounded.
      await seedUpcoming(client, 100, EVENTS_UPCOMING_PAGE_SIZE, new Date("2061-07-01T18:00:00Z"));
      const regrown = await listUpcoming(db, NOW, {}, 1);
      expect(regrown.rows).toHaveLength(EVENTS_UPCOMING_PAGE_SIZE);
      expect(regrown.totalPages).toBe(3);
    } finally {
      await fixture.dispose();
    }
  });

  it("renders a page past the end as empty with the page count intact", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await seedUpcoming(client, 0, 3, new Date("2060-07-01T18:00:00Z"));
      const { rows, hasMore, totalPages, total } = await listUpcoming(db, NOW, {}, 9);
      expect(rows).toEqual([]);
      expect(hasMore).toBe(false);
      expect(totalPages).toBe(1);
      expect(total).toBe(3);
    } finally {
      await fixture.dispose();
    }
  });

  it("scopes the month read to the chosen wall month", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await seedUpcoming(client, 0, 2, new Date("2060-07-15T18:00:00Z"));
      await seedUpcoming(client, 2, 2, new Date("2060-08-15T18:00:00Z"));
      const july = await listUpcomingForMonth(db, "2060-07", NOW);
      expect(july.map((row) => row.eventKey)).toEqual([key(0), key(1)]);
      const august = await listUpcomingForMonth(db, "2060-08", NOW);
      expect(august.map((row) => row.eventKey)).toEqual([key(2), key(3)]);
      expect(await listUpcomingForMonth(db, "2060-09", NOW)).toEqual([]);
      // A bad month is an empty grid, never a 500.
      expect(await listUpcomingForMonth(db, "banana", NOW)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("covers the grid's neighbor days but nothing outside the covered weeks", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      // Geometry-independent: the range helper and the read share the grid.
      const range = calendarGridRange("2060-07")!;
      const before = new Date(`${range.first}T18:00:00Z`).getTime() - 86400000;
      await seedUpcoming(client, 40, 1, new Date(`${range.first}T18:00:00Z`));
      await seedUpcoming(client, 41, 1, new Date(before));
      const july = await listUpcomingForMonth(db, "2060-07", NOW);
      expect(july.map((row) => row.eventKey)).toEqual([key(40)]);
    } finally {
      await fixture.dispose();
    }
  });

  it("ranks visible events for grid day-jumps and nulls the rest", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      expect(await rankUpcoming(db, key(0), NOW)).toBe(0);
      expect(await rankUpcoming(db, key(EVENTS_UPCOMING_PAGE_SIZE), NOW)).toBe(
        EVENTS_UPCOMING_PAGE_SIZE,
      );
      expect(await rankUpcoming(db, "01P99999999999999999999999", NOW)).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("resolves a grid day-jump to the list page holding the card", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      const application = app();
      const target = key(EVENTS_UPCOMING_PAGE_SIZE + 4);
      const jumped = await application.request(`/events?event=${target}`, {}, routeEnv(db));
      expect(jumped.status).toBe(200);
      const jumpedHtml = await jumped.text();
      expect(jumpedHtml).toContain("Page 2 of 2.");
      expect(jumpedHtml).toContain(`id="event-${target}"`);
      // An unknown key falls back to the requested page instead of failing.
      const missed = await application.request(
        "/events?event=01P99999999999999999999999",
        {},
        routeEnv(db),
      );
      expect(missed.status).toBe(200);
      expect(await missed.text()).toContain("Page 1 of 2.");
    } finally {
      await fixture.dispose();
    }
  });

  it("treats a NUL in the jump key as absent, not a 500", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      const application = app();
      const nulOnly = await application.request("/events?event=%00", {}, routeEnv(db));
      expect(nulOnly.status).toBe(200);
      expect(await nulOnly.text()).toContain("Page 1 of 2.");
      expect(nulOnly.headers.get("x-robots-tag")).toBeNull();
      const target = key(EVENTS_UPCOMING_PAGE_SIZE + 4);
      const jumped = await application.request(`/events?event=${target}%00`, {}, routeEnv(db));
      expect(jumped.status).toBe(200);
      expect(await jumped.text()).toContain(`id="event-${target}"`);
    } finally {
      await fixture.dispose();
    }
  });

  it("serves one page of cards with pager turns on GET /events", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      const application = app();
      const first = await application.request("/events", {}, routeEnv(db));
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      expect(cards(firstHtml)).toHaveLength(EVENTS_UPCOMING_PAGE_SIZE);
      expect(firstHtml).toContain('data-testid="events-pager"');
      expect(firstHtml).toContain('href="/events?page=2"');
      expect(firstHtml).not.toContain('data-testid="events-pager-prev"');

      const second = await application.request("/events?page=2", {}, routeEnv(db));
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(cards(secondHtml)).toHaveLength(5);
      expect(secondHtml).toContain("Page 2 of 2.");
      expect(secondHtml).toContain('href="/events"');

      const pastEnd = await application.request("/events?page=9", {}, routeEnv(db));
      expect(pastEnd.status).toBe(200);
      const pastEndHtml = await pastEnd.text();
      expect(cards(pastEndHtml)).toHaveLength(0);
      expect(pastEndHtml).toContain('data-testid="events-out-of-range"');
      expect(pastEndHtml).toContain("Page 9 is outside the schedule.");
    } finally {
      await fixture.dispose();
    }
  });

  it("scopes the month grid to the chosen month on GET /events", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedUpcoming(client, 0, 1, new Date("2060-07-15T18:00:00Z"));
      await seedUpcoming(client, 1, 1, new Date("2060-08-15T18:00:00Z"));
      const application = app();
      const response = await application.request(
        "/events?view=calendar&month=2060-07",
        {},
        routeEnv(db),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="events-calendar-grid"');
      expect(html).toContain("Paged 0");
      expect(html).not.toContain("Paged 1");
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps paged and jump renders noindex across anonymous cache hits", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      const application = app();
      // One shared env: the anonymous entry is source-scoped, so two
      // requests through one env hit the same entry like two crawler fetches.
      const env = routeEnv(db);
      const first = await application.request("/events?page=2", {}, env);
      expect(first.status).toBe(200);
      expect(first.headers.get("x-robots-tag")).toBe("noindex, follow");
      const firstHtml = await first.text();
      expect(firstHtml).toContain('name="robots" content="noindex, follow"');
      // The repeat serves the shared entry: the header is gone, but the
      // in-body meta survives, so the page is still noindex.
      const second = await application.request("/events?page=2", {}, env);
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toBe(firstHtml);
      expect(secondHtml).toContain('name="robots" content="noindex, follow"');
      // A grid day-jump resolves to its list page and stays noindex too.
      const jumpEnv = routeEnv(db);
      const target = key(EVENTS_UPCOMING_PAGE_SIZE + 4);
      const jumpFirst = await application.request(`/events?event=${target}`, {}, jumpEnv);
      expect(jumpFirst.status).toBe(200);
      const jumpFirstHtml = await jumpFirst.text();
      expect(jumpFirstHtml).toContain('name="robots" content="noindex, follow"');
      const jumpSecond = await application.request(`/events?event=${target}`, {}, jumpEnv);
      expect(await jumpSecond.text()).toBe(jumpFirstHtml);
      // Page one stays indexable: no header, no meta.
      const home = await application.request("/events", {}, routeEnv(db));
      expect(home.status).toBe(200);
      expect(home.headers.get("x-robots-tag")).toBeNull();
      expect(await home.text()).not.toContain('name="robots"');
    } finally {
      await fixture.dispose();
    }
  });

  it("announces and logs a search per query, not per page", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      __resetAnonEventCacheForTests();
      await seedUpcoming(
        client,
        0,
        EVENTS_UPCOMING_PAGE_SIZE + 5,
        new Date("2060-07-01T18:00:00Z"),
      );
      const application = app();
      const first = await application.request("/events?q=Paged", {}, routeEnv(db));
      expect(first.status).toBe(200);
      expect(await first.text()).toContain(eventsSearchHitCopy("Paged"));
      // A page past the end still announces a hit — its matches sit on
      // another page — and records no new search.
      const far = await application.request("/events?q=Paged&page=9", {}, routeEnv(db));
      expect(far.status).toBe(200);
      const farHtml = await far.text();
      expect(farHtml).toContain('data-testid="events-out-of-range"');
      expect(farHtml).toContain(eventsSearchHitCopy("Paged"));
      expect(farHtml).not.toContain(eventsSearchMissCopy("Paged"));
      // A page turn records no new search either: one row, query total.
      const turn = await application.request("/events?q=Paged&page=2", {}, routeEnv(db));
      expect(turn.status).toBe(200);
      const rows = await db.select().from(eventSearchLogs);
      expect(rows.map((r) => [r.normalizedQuery, r.resultCount])).toEqual([
        ["paged", EVENTS_UPCOMING_PAGE_SIZE + 5],
      ]);
    } finally {
      await fixture.dispose();
    }
  });
});
