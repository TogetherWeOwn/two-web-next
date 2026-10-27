// The distinct-games facet list is cached in memory: /events renders it on
// every miss, but games change only on event writes. A 60s TTL entry,
// retired on every event/RSVP mutation alongside the anonymous cards, turns
// the sequential games read into a cache hit.
//
// Pure unit tests: the cache functions are synchronous and need no database.
// The live block below pins the statement saving through the real read.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminSchema, schema } from "../src/db/index";
import {
  __resetAnonEventCacheForTests,
  readPublishedGamesCache,
  retireAnonEventCaches,
  writePublishedGamesCache,
  type AnonCacheSource,
} from "../src/events/anon-cache";
import { cachedListPublishedGames } from "../src/events/reads";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const source = (db: unknown): AnonCacheSource => ({ db, discord: null, appUrl: "https://x.test" });

describe("published games cache", () => {
  beforeEach(() => {
    __resetAnonEventCacheForTests();
  });

  it("misses when empty", () => {
    expect(readPublishedGamesCache(source("db-a"))).toBeNull();
  });

  it("hits within TTL for the same source", () => {
    writePublishedGamesCache(source("db-a"), ["Chess", "Go"], 60_000, 1_000);
    expect(readPublishedGamesCache(source("db-a"), 30_000)).toEqual(["Chess", "Go"]);
  });

  it("expires past TTL", () => {
    writePublishedGamesCache(source("db-a"), ["Chess"], 60_000, 1_000);
    expect(readPublishedGamesCache(source("db-a"), 61_001)).toBeNull();
  });

  it("misses for a different source", () => {
    writePublishedGamesCache(source("db-a"), ["Chess"], 60_000, 1_000);
    expect(readPublishedGamesCache(source("db-b"), 2_000)).toBeNull();
  });

  it("retire clears the entry", () => {
    writePublishedGamesCache(source("db-a"), ["Chess"], 60_000, 1_000);
    retireAnonEventCaches();
    expect(readPublishedGamesCache(source("db-a"), 2_000)).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("cached games read (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let statements = 0;
  let countedDb: MemberDataFixture["db"];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    countedDb = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: {
        logQuery() {
          statements += 1;
        },
      },
    });
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    __resetAnonEventCacheForTests();
    statements = 0;
  });

  it("serves repeated reads from cache and re-reads after retire", async () => {
    const dayMs = 86_400_000;
    const base = Date.now();
    await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status, game)
      values ('games-cache-0', 'Cached', ${new Date(base + dayMs).toISOString()}, ${new Date(base + dayMs + 3_600_000).toISOString()}, 'published', 'Chess')`;
    const src = source(countedDb);

    statements = 0;
    expect(await cachedListPublishedGames(countedDb, src)).toEqual(["Chess"]);
    expect(statements).toBe(1);
    // Second read hits the cache: no further statement.
    expect(await cachedListPublishedGames(countedDb, src)).toEqual(["Chess"]);
    expect(statements).toBe(1);
    // A retire forces a fresh read.
    retireAnonEventCaches();
    expect(await cachedListPublishedGames(countedDb, src)).toEqual(["Chess"]);
    expect(statements).toBe(2);
  });

  it("model uses provided games without querying the facet", async () => {
    const dayMs = 86_400_000;
    const base = Date.now();
    // Stored game is Go; the provided list carries Chess instead. If the
    // model queried, it would return Go.
    await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status, game)
      values ('games-provided-0', 'Provided', ${new Date(base + dayMs).toISOString()}, ${new Date(base + dayMs + 3_600_000).toISOString()}, 'published', 'Go')`;
    const discord = { upcoming: async () => [], lastReadFailed: () => false };
    const model = await loadCalendarPageModel({
      db: countedDb,
      input: resolveCalendarInput({ game: "chess" }),
      includeDrafts: false,
      discord,
      now: new Date(base),
      games: ["Chess"],
    });
    expect(model.games).toEqual(["Chess"]);
    expect(model.gameFilter).toBe("Chess");
  });
});
