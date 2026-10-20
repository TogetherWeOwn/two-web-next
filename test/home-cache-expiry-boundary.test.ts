// Homepage guest-cache exact-expiry + warm featured-window boundary pins.
//
// Hermetic and test-only: offline pg-proxy DB/Discord fixtures and a controlled
// wall clock prove, for both cache key modes (injected ADMIN_DB object and
// URL-keyed production path), that entries hit at TTL-1ms (+59,999ms) and miss
// exactly at TTL (+60,000ms) with no sliding extension from intervening hits,
// and that a warm featured base re-filters at its inclusive start / exclusive
// end without another DB read. No production behavior change here.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  __resetHomeGuestCacheForTests,
  cachedFeatured,
  cachedHomeUpcoming,
  HOME_GUEST_CACHE_TTL_MS,
} from "../src/home-cache";
import { createMemorySessionStore } from "../src/sessions";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const NOW = new Date("2030-07-04T18:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

let urlCounter = 0;

afterEach(() => {
  __resetHomeGuestCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function eventRow(id: number): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: null,
    purpose: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type EventRows = (typeof events.$inferSelect)[];

function makeUpcomingDb(initial: EventRows, featuredRows: unknown[][] = []) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  let rows = initial;
  let eventQueries = 0;
  let featuredQueries = 0;
  const setRows = (next: EventRows) => {
    rows = next;
  };
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (sql.includes('from "featured_contents"')) {
      featuredQueries += 1;
      return { rows: featuredRows };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) {
      eventQueries += 1;
      return { rows: [] };
    }
    if (sql.includes('from "events"')) {
      eventQueries += 1;
      return {
        rows: rows.map((row) =>
          columns.map((key) => {
            const value = row[key];
            return value instanceof Date ? value.toISOString() : value;
          }),
        ),
      };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return { db, setRows, counts: () => ({ eventQueries, featuredQueries }) };
}

function makeFeaturedDb(initialRows: unknown[][]) {
  let rows = initialRows;
  let featuredQueries = 0;
  const setRows = (next: unknown[][]) => {
    rows = next;
  };
  const db = drizzle(async (sql: string) => {
    if (sql.includes('from "featured_contents"')) {
      featuredQueries += 1;
      return { rows };
    }
    if (sql.includes("set_config")) return { rows: [] };
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return { db, setRows, counts: () => ({ featuredQueries }) };
}

function injectedEnv(db: Db): Env {
  return {
    ...baseEnv,
    ADMIN_DB: db,
    SESSION_STORE: createMemorySessionStore(),
    DISCORD_EVENTS: {
      upcoming: async () => [],
      lastReadFailed: () => false,
    },
  } as Env;
}

function urlEnv(): Env {
  urlCounter += 1;
  return {
    ...baseEnv,
    DATABASE_URL: `postgres://boundary-test.invalid/db-${urlCounter}`,
  };
}

const discordSource = () => ({ upcoming: async () => [], lastReadFailed: () => false });
const throwingOpenDb = async (): Promise<Db> => {
  throw new Error("DB must not be touched on a cache hit");
};
const throwingDiscord = () => ({
  upcoming: async (): Promise<never[]> => {
    throw new Error("Discord must not be touched on a cache hit");
  },
  lastReadFailed: () => false,
});

function featuredRow(
  id: number,
  title: string,
  startsAt: Date | null,
  endsAt: Date | null,
): unknown[] {
  return [
    id,
    title,
    `${title} body`,
    null,
    null,
    null,
    startsAt ? startsAt.toISOString() : null,
    endsAt ? endsAt.toISOString() : null,
  ];
}

describe("homepage cache TTL source", () => {
  it("uses a 60-second TTL", () => {
    // Acceptance numbers (+59,999ms hit / +60,000ms miss) derive from this
    // constant; the boundary tests below use TTL-1 and TTL arithmetic so an
    // off-by-one production change fails them.
    expect(HOME_GUEST_CACHE_TTL_MS).toBe(60_000);
  });
});

describe("homepage cache exact expiry (injected ADMIN_DB)", () => {
  it("hits upcoming at TTL-1ms and re-reads exactly at TTL without sliding", async () => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const TTL = HOME_GUEST_CACHE_TTL_MS;
      const fix = makeUpcomingDb([eventRow(1)]);
      const env = injectedEnv(fix.db);
      vi.setSystemTime(NOW);
      const first = await cachedHomeUpcoming(env, async () => fix.db, discordSource, new Date());
      expect(first.unavailable).toBe(false);
      expect(first.discordFailed).toBe(false);
      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.title).toBe("Game night 1");
      expect(first.items[0]?.startsAt).toBeInstanceOf(Date);
      const afterFirst = fix.counts();
      expect(afterFirst.eventQueries).toBeGreaterThan(0);

      // Intervening hits must not extend expiry: each uses a throwing opener
      // so any extra DB read fails the case instead of hiding a slide.
      for (const offset of [10_000, 30_000, TTL - 1]) {
        vi.setSystemTime(new Date(NOW.getTime() + offset));
        const hit = await cachedHomeUpcoming(env, throwingOpenDb, throwingDiscord, new Date());
        expect(hit.unavailable).toBe(false);
        expect(hit.items).toHaveLength(1);
        expect(hit.items[0]?.title).toBe("Game night 1");
        expect(hit.items[0]?.startsAt.getTime()).toBe(first.items[0]?.startsAt.getTime());
        expect(fix.counts()).toEqual(afterFirst);
      }

      // Exactly at TTL the entry lapses: swap the rows first so the fresh read
      // proves itself with new model content (not the stale title).
      fix.setRows([eventRow(2)]);
      vi.setSystemTime(new Date(NOW.getTime() + TTL));
      const fresh = await cachedHomeUpcoming(env, async () => fix.db, discordSource, new Date());
      expect(fresh.unavailable).toBe(false);
      expect(fresh.items).toHaveLength(1);
      expect(fresh.items[0]?.title).toBe("Game night 2");
      expect(fresh.items[0]?.startsAt.getTime()).toBe(
        new Date(NOW.getTime() + 2 * 3600_000).getTime(),
      );
      expect(fix.counts().eventQueries).toBeGreaterThan(afterFirst.eventQueries);
    } finally {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    }
  });

  it("hits featured at TTL-1ms and re-reads exactly at TTL without sliding", async () => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const TTL = HOME_GUEST_CACHE_TTL_MS;
      const fix = makeFeaturedDb([featuredRow(1, "Community news", null, null)]);
      const env = injectedEnv(fix.db);
      vi.setSystemTime(NOW);
      const first = await cachedFeatured(env, async () => fix.db, new Date());
      expect(first).toHaveLength(1);
      expect(first[0]?.title).toBe("Community news");
      expect(first[0]?.body).toBe("Community news body");
      const afterFirst = fix.counts().featuredQueries;
      expect(afterFirst).toBeGreaterThan(0);

      for (const offset of [10_000, 30_000, TTL - 1]) {
        vi.setSystemTime(new Date(NOW.getTime() + offset));
        const hit = await cachedFeatured(env, throwingOpenDb, new Date());
        expect(hit).toHaveLength(1);
        expect(hit[0]?.title).toBe("Community news");
        expect(hit).toEqual(first);
        expect(fix.counts().featuredQueries).toBe(afterFirst);
      }

      fix.setRows([featuredRow(2, "Late slot", null, null)]);
      vi.setSystemTime(new Date(NOW.getTime() + TTL));
      const fresh = await cachedFeatured(env, async () => fix.db, new Date());
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.title).toBe("Late slot");
      expect(fresh[0]?.body).toBe("Late slot body");
      expect(fix.counts().featuredQueries).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    }
  });
});

describe("homepage cache exact expiry (URL-keyed production path)", () => {
  it("hits upcoming at TTL-1ms and re-reads exactly at TTL without sliding", async () => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const TTL = HOME_GUEST_CACHE_TTL_MS;
      const fix = makeUpcomingDb([eventRow(1)]);
      const env = urlEnv();
      vi.setSystemTime(NOW);
      const first = await cachedHomeUpcoming(env, async () => fix.db, discordSource, new Date());
      expect(first.unavailable).toBe(false);
      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.title).toBe("Game night 1");
      const afterFirst = fix.counts();
      expect(afterFirst.eventQueries).toBeGreaterThan(0);

      for (const offset of [10_000, 30_000, TTL - 1]) {
        vi.setSystemTime(new Date(NOW.getTime() + offset));
        const hit = await cachedHomeUpcoming(env, throwingOpenDb, throwingDiscord, new Date());
        expect(hit.unavailable).toBe(false);
        expect(hit.items.map((item) => item.title)).toEqual(["Game night 1"]);
        expect(fix.counts()).toEqual(afterFirst);
      }

      fix.setRows([eventRow(2)]);
      vi.setSystemTime(new Date(NOW.getTime() + TTL));
      const fresh = await cachedHomeUpcoming(env, async () => fix.db, discordSource, new Date());
      expect(fresh.items.map((item) => item.title)).toEqual(["Game night 2"]);
      expect(fix.counts().eventQueries).toBeGreaterThan(afterFirst.eventQueries);
    } finally {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    }
  });

  it("hits featured at TTL-1ms and re-reads exactly at TTL without sliding", async () => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const TTL = HOME_GUEST_CACHE_TTL_MS;
      const fix = makeFeaturedDb([featuredRow(1, "Community news", null, null)]);
      const env = urlEnv();
      vi.setSystemTime(NOW);
      const first = await cachedFeatured(env, async () => fix.db, new Date());
      expect(first).toHaveLength(1);
      expect(first[0]?.title).toBe("Community news");
      const afterFirst = fix.counts().featuredQueries;

      for (const offset of [10_000, 30_000, TTL - 1]) {
        vi.setSystemTime(new Date(NOW.getTime() + offset));
        const hit = await cachedFeatured(env, throwingOpenDb, new Date());
        expect(hit).toEqual(first);
        expect(fix.counts().featuredQueries).toBe(afterFirst);
      }

      fix.setRows([featuredRow(2, "Late slot", null, null)]);
      vi.setSystemTime(new Date(NOW.getTime() + TTL));
      const fresh = await cachedFeatured(env, async () => fix.db, new Date());
      expect(fresh.map((row) => row.title)).toEqual(["Late slot"]);
      expect(fix.counts().featuredQueries).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    }
  });
});

describe("warm featured base window transitions", () => {
  it("re-filters the cached base at its inclusive start and exclusive end (injected)", async () => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = new Date(NOW.getTime() + 10_000);
      const end = new Date(NOW.getTime() + 20_000);
      const fix = makeFeaturedDb([featuredRow(1, "Window slot", start, end)]);
      const env = injectedEnv(fix.db);

      // Store the base while the window is still scheduled: nothing visible
      // yet, but the non-empty base must be cached (an empty-visible-list
      // cache would hide the upcoming start).
      vi.setSystemTime(NOW);
      const scheduled = await cachedFeatured(env, async () => fix.db, new Date());
      expect(scheduled).toEqual([]);
      const storedQueries = fix.counts().featuredQueries;
      expect(storedQueries).toBeGreaterThan(0);

      // Swap the table behind the cache: every later read must still serve
      // the cached base, proving no DB read happens below.
      fix.setRows([featuredRow(9, "Other slot", null, null)]);

      // Inclusive start: visible without a re-read.
      vi.setSystemTime(new Date(start.getTime()));
      const atStart = await cachedFeatured(env, async () => fix.db, new Date());
      expect(atStart).toHaveLength(1);
      expect(atStart[0]?.title).toBe("Window slot");
      expect(atStart[0]?.body).toBe("Window slot body");
      expect(fix.counts().featuredQueries).toBe(storedQueries);

      // Still visible 1ms before the exclusive end.
      vi.setSystemTime(new Date(end.getTime() - 1));
      const beforeEnd = await cachedFeatured(env, async () => fix.db, new Date());
      expect(beforeEnd.map((row) => row.title)).toEqual(["Window slot"]);
      expect(fix.counts().featuredQueries).toBe(storedQueries);

      // Exclusive end: gone without a re-read (a fresh read would see Other).
      vi.setSystemTime(new Date(end.getTime()));
      const atEnd = await cachedFeatured(env, async () => fix.db, new Date());
      expect(atEnd).toEqual([]);
      expect(fix.counts().featuredQueries).toBe(storedQueries);
    } finally {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    }
  });

  it("re-filters the cached base at its inclusive start and exclusive end (URL-keyed)", async () => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = new Date(NOW.getTime() + 10_000);
      const end = new Date(NOW.getTime() + 20_000);
      const fix = makeFeaturedDb([featuredRow(1, "Window slot", start, end)]);
      const env = urlEnv();

      vi.setSystemTime(NOW);
      expect(await cachedFeatured(env, async () => fix.db, new Date())).toEqual([]);
      const storedQueries = fix.counts().featuredQueries;
      expect(storedQueries).toBeGreaterThan(0);

      fix.setRows([featuredRow(9, "Other slot", null, null)]);

      vi.setSystemTime(new Date(start.getTime()));
      const atStart = await cachedFeatured(env, async () => fix.db, new Date());
      expect(atStart.map((row) => row.title)).toEqual(["Window slot"]);
      expect(fix.counts().featuredQueries).toBe(storedQueries);

      vi.setSystemTime(new Date(end.getTime() - 1));
      expect(
        (await cachedFeatured(env, async () => fix.db, new Date())).map((row) => row.title),
      ).toEqual(["Window slot"]);
      expect(fix.counts().featuredQueries).toBe(storedQueries);

      vi.setSystemTime(new Date(end.getTime()));
      expect(await cachedFeatured(env, async () => fix.db, new Date())).toEqual([]);
      expect(fix.counts().featuredQueries).toBe(storedQueries);
    } finally {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    }
  });
});
