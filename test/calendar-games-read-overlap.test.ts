// The distinct-games facet read must not gate the page reads when no game was
// requested: it runs beside them (one fewer sequential round trip on a plain
// `/events` render). A requested game still resolves against the list first.
// Synthetic read models; no database, Discord, browser or staging dependencies.
//
// The doubles are plain functions behind a hoisted holder (not vi.spyOn):
// @vitest/spy attaches a settlement handler to every promise a spy returns,
// which would mask an unhandled games-read rejection the rank-jump test pins.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";

type Reads = typeof import("../src/events/reads");
type Double = (...args: never[]) => unknown;
type DoubleKey = "listPublishedGames" | "listUpcoming" | "listCalendarPast" | "rankUpcoming";

const doubles = vi.hoisted(() => ({
  listPublishedGames: undefined as Double | undefined,
  listUpcoming: undefined as Double | undefined,
  listCalendarPast: undefined as Double | undefined,
  rankUpcoming: undefined as Double | undefined,
}));

vi.mock("../src/events/reads", async (importOriginal) => {
  const original = await importOriginal<Reads>();
  const delegate = (key: DoubleKey): Double => {
    const fn = (...args: never[]): unknown => {
      const impl = doubles[key];
      if (!impl) throw new Error(`unexpected ${key} call (no test double installed)`);
      return impl(...args);
    };
    return fn;
  };
  return {
    ...original,
    listPublishedGames: delegate("listPublishedGames"),
    listUpcoming: delegate("listUpcoming"),
    listCalendarPast: delegate("listCalendarPast"),
    rankUpcoming: delegate("rankUpcoming"),
  };
});

const NOW = new Date("2026-10-27T12:00:00Z");
const discord = { upcoming: async () => [], lastReadFailed: () => false };

function setup() {
  const started: string[] = [];
  let releaseGames!: (games: string[]) => void;
  let rejectGames!: (reason?: unknown) => void;
  const gamesPending = new Promise<string[]>((resolve, reject) => {
    releaseGames = resolve;
    rejectGames = reject;
  });
  const optsSeen: unknown[] = [];
  const pastOptsSeen: unknown[] = [];
  doubles.listPublishedGames = async () => {
    started.push("games");
    return gamesPending;
  };
  doubles.listUpcoming = async (_db, _now, opts) => {
    started.push("upcoming");
    optsSeen.push(opts);
    return { rows: [], hasMore: false, totalPages: 0, total: 0 };
  };
  doubles.listCalendarPast = async (_db, _now, opts) => {
    started.push("past");
    pastOptsSeen.push(opts);
    return [];
  };
  doubles.rankUpcoming = undefined;
  return { started, releaseGames, rejectGames, optsSeen, pastOptsSeen };
}

const load = (query: Parameters<typeof resolveCalendarInput>[0]) =>
  loadCalendarPageModel({
    db: {} as Db,
    input: resolveCalendarInput(query),
    includeDrafts: false,
    discord,
    now: NOW,
  });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("calendar canonical read: games facet overlap", () => {
  it.each([{}, { game: "" }, { game: "   " }])(
    "starts the page reads while the games read is pending (%j)",
    async (query) => {
      const { started, releaseGames } = setup();
      const model = load(query);
      await flush();
      expect(started).toEqual(["games", "upcoming", "past"]);
      releaseGames(["Chess"]);
      const { games, gameFilter } = await model;
      expect(games).toEqual(["Chess"]);
      expect(gameFilter).toBeNull();
    },
  );

  it("still resolves a requested game before the page reads", async () => {
    const { started, releaseGames, optsSeen, pastOptsSeen } = setup();
    const model = load({ game: "chess" });
    await flush();
    expect(started).toEqual(["games"]);
    releaseGames(["Chess"]);
    const { gameFilter } = await model;
    expect(started).toEqual(["games", "upcoming", "past"]);
    expect(gameFilter).toBe("Chess");
    expect(optsSeen[0]).toMatchObject({ game: "Chess" });
    expect(pastOptsSeen[0]).toMatchObject({ game: "Chess" });
  });

  it("propagates a games read failure on the overlapped path", async () => {
    setup();
    doubles.listPublishedGames = async () => {
      throw new Error("games down");
    };
    await expect(load({})).rejects.toThrow("games down");
  });

  it("rejects with the rank error and nothing unhandled when games fails during a rank jump", async () => {
    const { rejectGames } = setup();
    let rejectRank!: (reason?: unknown) => void;
    const rankPending = new Promise<number | null>((_resolve, reject) => {
      rejectRank = reject;
    });
    doubles.rankUpcoming = () => rankPending;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const model = load({ event: "jump" });
      await flush();
      rejectGames(new Error("games down"));
      await flush();
      rejectRank(new Error("rank down"));
      await expect(model).rejects.toThrow("rank down");
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
