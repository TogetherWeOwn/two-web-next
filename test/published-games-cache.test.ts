// Retiring a facet cache must fence deferred loaders, not only settled bytes.
// All assertions run offline, with the same read-through proofs on guarded
// disposable Postgres whenever DATABASE_URL is set.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import {
  __resetAnonEventCacheForTests,
  readPublishedGamesCache,
  retireAnonEventCaches,
  writePublishedGamesCache,
  type AnonCacheSource,
} from "../src/events/anon-cache";
import { cachedListPublishedGames } from "../src/events/reads";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { createEventsPerfFixture, type EventsPerfFixture } from "./helpers/events-perf-fixture";

const source = (db: unknown): AnonCacheSource => ({ db, discord: null, appUrl: "https://x.test" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  it("lets a retired in-flight caller finish without repopulating the facet cache", async () => {
    const entered = deferred<void>();
    const result = deferred<{ rows: unknown[][] }>();
    const db = drizzle(async () => {
      entered.resolve();
      return result.promise;
    }) as unknown as Db;
    const src = source(db);
    const pending = cachedListPublishedGames(db, src);
    try {
      await entered.promise;
      expect(readPublishedGamesCache(src)).toBeNull();
      retireAnonEventCaches();
    } finally {
      result.resolve({ rows: [["Old game"]] });
    }
    expect(await pending).toEqual(["Old game"]);
    expect(readPublishedGamesCache(src), "retirement must fence late settlement").toBeNull();
  });

  it("does not let an older retired loader overwrite a fresh post-retirement entry", async () => {
    const entered = deferred<void>();
    const oldResult = deferred<{ rows: unknown[][] }>();
    let calls = 0;
    const db = drizzle(async () => {
      if (++calls === 1) {
        entered.resolve();
        return oldResult.promise;
      }
      return { rows: [["New game"]] };
    }) as unknown as Db;
    const src = source(db);
    const pending = cachedListPublishedGames(db, src);
    try {
      await entered.promise;
      retireAnonEventCaches();
      expect(await cachedListPublishedGames(db, src)).toEqual(["New game"]);
      expect(readPublishedGamesCache(src)).toEqual(["New game"]);
    } finally {
      oldResult.resolve({ rows: [["Old game"]] });
    }
    expect(await pending).toEqual(["Old game"]);
    expect(readPublishedGamesCache(src)).toEqual(["New game"]);
  });

  it("accepts a deferred facet while Discord starts independently of it", async () => {
    const facet = deferred<string[]>();
    const statements: string[] = [];
    const db = drizzle(async (sql) => {
      statements.push(sql);
      return { rows: sql.startsWith("select count(*)") ? [[0]] : [] };
    }) as unknown as Db;
    let discordStarted = false;
    const pending = loadCalendarPageModel({
      db,
      input: resolveCalendarInput({ game: "chess" }),
      includeDrafts: false,
      discord: {
        upcoming: async () => {
          discordStarted = true;
          return [];
        },
        lastReadFailed: () => false,
      },
      now: new Date("2030-07-04T18:00:00Z"),
      games: facet.promise,
    });
    // Observe rejection without turning it into a replacement model. The
    // held facet is always released even when an overlap assertion fails.
    void pending.catch(() => {});
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(discordStarted, "Discord must start before the facet resolves").toBe(true);
    } finally {
      facet.resolve(["Chess"]);
    }
    const model = await pending;
    expect(model.games).toEqual(["Chess"]);
    expect(model.gameFilter).toBe("Chess");
    expect(statements.filter((sql) => /^select distinct\b/.test(sql))).toHaveLength(0);
  });
});

describe("cached games read", () => {
  let fixture: EventsPerfFixture;

  beforeAll(async () => {
    fixture = await createEventsPerfFixture();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
    __resetAnonEventCacheForTests();
  });

  it("serves repeated reads from cache and re-reads after retire", async () => {
    await fixture.seedEvent({ eventKey: "games-cache-0", game: "Chess" });
    const src = source(fixture.db);

    fixture.statements.length = 0;
    expect(await cachedListPublishedGames(fixture.db, src)).toEqual(["Chess"]);
    expect(fixture.statements).toHaveLength(1);
    expect(await cachedListPublishedGames(fixture.db, src)).toEqual(["Chess"]);
    expect(fixture.statements).toHaveLength(1);
    retireAnonEventCaches();
    expect(await cachedListPublishedGames(fixture.db, src)).toEqual(["Chess"]);
    expect(fixture.statements).toHaveLength(2);
  });

  it("model uses provided games without querying the facet", async () => {
    const base = Date.now();
    await fixture.seedEvent({ eventKey: "games-provided-0", game: "Go" });
    const discord = { upcoming: async () => [], lastReadFailed: () => false };
    const model = await loadCalendarPageModel({
      db: fixture.db,
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
