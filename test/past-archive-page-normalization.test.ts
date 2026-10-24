// route-inventory: GET /events/past
// Pin the past-archive page-normalization contract: invalid HTML archive
// pages fall back to page one with no OFFSET, and far-past-the-end pages
// echo with a stable total from the count alone (no row or OFFSET query).
// Real app + agent-testdb/CI Postgres for the route/read halves, with a
// Drizzle statement logger on a second handle over the fixture pool (seeds
// stay uncounted); the pure normalizer pins always run. The mock-DB suite
// test/islands-past-events.test.ts pins the same statement shape against a
// fake driver; this file proves it against real Postgres.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db/index";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { listPast, normalizePastPage, PAGE_SIZE } from "../src/events/reads";
import {
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  pastEventsOutOfRangeCopy,
} from "../src/islands/contracts";
import type { Env } from "../src/env";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";

describe("normalizePastPage", () => {
  it.each([0, -1, -999, Number.NaN, Infinity, -Infinity, 1.5, 0.5, 2.5])(
    "falls back to page one for invalid numeric page %s",
    (page) => {
      expect(normalizePastPage(page)).toBe(1);
    },
  );

  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "falls back to page one when the offset overflows safe integers (%s)",
    (page) => {
      expect(Number.isSafeInteger((page - 1) * PAGE_SIZE)).toBe(false);
      expect(normalizePastPage(page)).toBe(1);
    },
  );

  it("falls back one past the largest safe offset", () => {
    const lastSafe = Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 1;
    expect(normalizePastPage(lastSafe)).toBe(lastSafe);
    expect(normalizePastPage(lastSafe + 1)).toBe(1);
  });

  it.each([1, 2, 9, 999])(`preserves the safe page %s`, (page) => {
    expect(normalizePastPage(page)).toBe(page);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("past-archive page normalization (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let countedDb: Db;
  let statements: string[] = [];
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    countedDb = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: {
        logQuery(query) {
          statements.push(query);
        },
      },
    });
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    // Page-one renders settle in the shared anon cache under the normalized
    // page; clear it so every case reaches the read instead of a cache hit.
    __resetAnonEventCacheForTests();
    statements = [];
  });

  async function seedTwentyFive() {
    await db.insert(events).values(
      Array.from({ length: 25 }, (_, i) => ({
        eventKey: `archive-${i + 1}`,
        title: `Past game ${i + 1}`,
        status: "past",
        startsAt: new Date(Date.UTC(2020, 0, i + 1, 20)),
        endsAt: new Date(Date.UTC(2020, 0, i + 1, 22)),
      })),
    );
  }

  const keys = (html: string) => [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
  const pageOneKeys = Array.from({ length: 20 }, (_, i) => `archive-${25 - i}`);

  // Only the archive count statement: a far-past page must stop before any
  // row read, so no OFFSET is ever sent for it.
  function expectCountOnly() {
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^select count\(\*\)/);
    expect(statements[0]).not.toContain(" offset ");
  }

  // `null` requests the archive with no query string; "" sends `?page=`.
  it.each(["0", "-1", "invalid", "", "NaN", "9".repeat(400), null])(
    "falls back to page one for %j with a 200, the clamped page echoed and no OFFSET",
    async (raw) => {
      await seedTwentyFive();
      const path = raw === null ? "/events/past" : `/events/past?page=${raw}`;
      statements = [];
      const res = await app.request(path, {}, { ...env, ADMIN_DB: countedDb });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(keys(html)).toEqual(pageOneKeys);
      expect(html).toContain('data-page="1"');
      expect(html).toContain('data-total-pages="2"');
      expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past"`);
      expect(html).not.toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
      // Count, page-one rows and the two going aggregates (attributable +
      // occupancy); Drizzle elides a zero offset, so a clamped page sends none.
      expect(statements).toHaveLength(4);
      for (const statement of statements) expect(statement).not.toContain(" offset ");
    },
  );

  it.each(["3", "9", "999"])(
    "echoes far-past-the-end page %s with a stable total from the count alone",
    async (raw) => {
      await seedTwentyFive();
      statements = [];
      const res = await app.request(
        `/events/past?page=${raw}`,
        {},
        { ...env, ADMIN_DB: countedDb },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(keys(html)).toEqual([]);
      expect(html).toContain(`data-page="${raw}"`);
      expect(html).toContain('data-total-pages="2"');
      expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past?page=${raw}"`);
      expect(html).toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
      expect(html).toContain(pastEventsOutOfRangeCopy(Number(raw), 2));
      expectCountOnly();
    },
  );

  it.each([0, -1, Number.NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
    "guards direct archive reads for invalid numeric page %s",
    async (page) => {
      await seedTwentyFive();
      const result = await listPast(db, page);
      expect(result.rows.map((row) => row.eventKey)).toEqual(pageOneKeys);
      expect(result.totalPages).toBe(2);
      expect(result.hasMore).toBe(true);
    },
  );

  it("keeps the total stable for a far-past-the-end direct read from the count alone", async () => {
    await seedTwentyFive();
    statements = [];
    const result = await listPast(countedDb, 999);
    expect(result.rows).toEqual([]);
    expect(result.totalPages).toBe(2);
    expect(result.hasMore).toBe(false);
    expectCountOnly();
  });
});
