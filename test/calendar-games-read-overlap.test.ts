// The distinct-games facet read must not gate the page reads when no game was
// requested: it runs beside them (one fewer sequential round trip on a plain
// `/events` render). A requested game still resolves against the list first.
// Synthetic read models; no database, Discord, browser or staging dependencies.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import * as reads from "../src/events/reads";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";

const NOW = new Date("2026-10-27T12:00:00Z");
const discord = { upcoming: async () => [], lastReadFailed: () => false };

function setup() {
  const started: string[] = [];
  let releaseGames!: (games: string[]) => void;
  const gamesPending = new Promise<string[]>((resolve) => {
    releaseGames = resolve;
  });
  const optsSeen: unknown[] = [];
  vi.spyOn(reads, "listPublishedGames").mockImplementation(async () => {
    started.push("games");
    return gamesPending;
  });
  vi.spyOn(reads, "listUpcoming").mockImplementation(async (_db, _now, opts) => {
    started.push("upcoming");
    optsSeen.push(opts);
    return { rows: [], hasMore: false, totalPages: 0, total: 0 };
  });
  vi.spyOn(reads, "listCalendarPast").mockImplementation(async () => {
    started.push("past");
    return [];
  });
  return { started, releaseGames, optsSeen };
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

afterEach(() => vi.restoreAllMocks());

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
    const { started, releaseGames, optsSeen } = setup();
    const model = load({ game: "chess" });
    await flush();
    expect(started).toEqual(["games"]);
    releaseGames(["Chess"]);
    const { gameFilter } = await model;
    expect(started).toEqual(["games", "upcoming", "past"]);
    expect(gameFilter).toBe("Chess");
    expect(optsSeen[0]).toMatchObject({ game: "Chess" });
  });

  it("propagates a games read failure on the overlapped path", async () => {
    setup();
    vi.spyOn(reads, "listPublishedGames").mockRejectedValue(new Error("games down"));
    await expect(load({})).rejects.toThrow("games down");
  });
});
