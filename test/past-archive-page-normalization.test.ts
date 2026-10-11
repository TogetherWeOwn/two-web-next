// route-inventory: GET /events/past
// Pin the past-archive page-normalization contract: invalid HTML archive
// pages fall back to page one, far-past-the-end pages echo with a stable
// total instead of scanning, and the read layer never issues an unbounded
// OFFSET. Real app + agent-testdb/CI Postgres for the route/read halves;
// the pure normalizer pins always run.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
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
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
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

  it.each(["0", "-1", "invalid", "", "NaN", "9".repeat(400)])(
    "falls back to page one for %s with a 200 and the clamped page echoed",
    async (raw) => {
      await seedTwentyFive();
      const path = raw === "" ? "/events/past" : `/events/past?page=${raw}`;
      const res = await app.request(path, {}, { ...env, ADMIN_DB: db });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(keys(html)).toEqual(pageOneKeys);
      expect(html).toContain('data-page="1"');
      expect(html).toContain('data-total-pages="2"');
      expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past"`);
      expect(html).not.toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
    },
  );

  it.each(["3", "9", "999"])(
    "echoes far-past-the-end page %s with a stable total instead of scanning",
    async (raw) => {
      await seedTwentyFive();
      const res = await app.request(`/events/past?page=${raw}`, {}, { ...env, ADMIN_DB: db });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(keys(html)).toEqual([]);
      expect(html).toContain(`data-page="${raw}"`);
      expect(html).toContain('data-total-pages="2"');
      expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past?page=${raw}"`);
      expect(html).toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
      expect(html).toContain(pastEventsOutOfRangeCopy(Number(raw), 2));
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

  it("keeps the total stable for a far-past-the-end direct read", async () => {
    await seedTwentyFive();
    const result = await listPast(db, 999);
    expect(result.rows).toEqual([]);
    expect(result.totalPages).toBe(2);
    expect(result.hasMore).toBe(false);
  });
});
