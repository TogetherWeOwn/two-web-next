// Fail-open arms of the Kit events load (src/kit-events.ts): a throwing
// session read degrades to an anonymous render and a throwing flash read
// degrades to no banner. Hermetic: every boundary is an injected stub, no
// database, no network, no clock asserts.
import { describe, expect, it, vi } from "vitest";
import { loadEventsPage } from "../src/kit-events";

const env = {
  APP_URL: "https://example.test",
  DISCORD_INVITE_URL: "https://discord.gg/example",
} as never;

const baseModel = () => ({
  state: {
    view: "list",
    month: "2026-10",
    q: "",
    game: "",
    past: false,
    page: 1,
    weekStart: "monday",
  },
  upcoming: [],
  past: [],
  zone: "Europe/London",
  totalPages: 1,
  emptyState: null,
  robots: undefined,
  games: [],
  gameFilter: null,
  discordFailed: false,
});

function loadArgs(overrides: Record<string, unknown> = {}) {
  const setHeaders = vi.fn();
  const deleteJoinCookie = vi.fn();
  return {
    args: {
      env,
      url: new URL("https://example.test/events"),
      method: "GET",
      island: false,
      request: new Request("https://example.test/events"),
      setHeaders,
      deleteJoinCookie,
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      modelForFn: async () => baseModel(),
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
      ...overrides,
    } as Parameters<typeof loadEventsPage>[0],
    setHeaders: setHeaders as ReturnType<typeof vi.fn>,
    deleteJoinCookie: deleteJoinCookie as ReturnType<typeof vi.fn>,
  };
}

describe("Kit events load fail-open", () => {
  it("a throwing session read degrades to an anonymous public render", async () => {
    const modelForFn = vi.fn(async () => baseModel());
    const { args, setHeaders } = loadArgs({
      sessionForFn: async () => {
        throw new Error("session store down");
      },
      modelForFn,
    });
    const data = await loadEventsPage(args);
    expect(data).toMatchObject({ member: false, moderator: false, queryTooLong: false });
    // Anonymous, search-free and flash-free: the dispatch may share this HTML.
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "public, max-age=60" }),
    );
    expect(modelForFn).toHaveBeenCalledWith(expect.objectContaining({ includeDrafts: false }));
  });

  it("a throwing flash read degrades to no banner and keeps the cookie", async () => {
    const { args, setHeaders, deleteJoinCookie } = loadArgs({
      journeyForFn: async () => {
        throw new Error("flash read down");
      },
    });
    const data = await loadEventsPage(args);
    expect(data).toMatchObject({ joinResult: null, queryTooLong: false });
    expect(deleteJoinCookie).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "public, max-age=60" }),
    );
  });

  it("an island fragment never touches the flash, even when the flash read throws", async () => {
    const journeyForFn = vi.fn(async () => {
      throw new Error("flash read down");
    });
    const { args } = loadArgs({ island: true, journeyForFn });
    const data = await loadEventsPage(args);
    expect(data).toMatchObject({ joinResult: null, queryTooLong: false });
    expect(journeyForFn).not.toHaveBeenCalled();
  });
});
