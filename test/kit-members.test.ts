import { describe, expect, it, vi } from "vitest";
import { loadMembersBoardData } from "../src/kit-members";

const env = { APP_URL: "https://example.test" } as never;
const headers = () => vi.fn((_headers: Record<string, string>) => {});
const memberSession = { status: "authenticated" as const, userId: "u-viewer", member: true };
const ranked = [
  { userId: "u-a", username: "Ana", count: 5 },
  { userId: "u-viewer", username: "Vic", count: 3 },
  { userId: "u-b", username: "Bo", count: 1 },
];

function args(overrides: Record<string, unknown> = {}) {
  return {
    env,
    session: memberSession,
    seasonParam: null,
    scopeParam: null,
    activityParam: null,
    setHeaders: headers(),
    dbForFn: async () => ({}) as never,
    loadRankingFn: async () => ranked,
    recordBoardViewFn: async () => {},
    ...overrides,
  };
}

describe("Kit member-board load parity", () => {
  it("serves the overall board, records the anonymous board view and answers private, no-store", async () => {
    const db = {} as never;
    const recordBoardViewFn = vi.fn(async () => {});
    const setHeaders = headers();
    const data = await loadMembersBoardData(
      args({ dbForFn: async () => db, recordBoardViewFn, setHeaders }),
    );
    expect(data.season).toBe("all");
    expect(data.scope).toBe("overall");
    expect(data.activity).toBeNull();
    expect(data.rows.map((row) => row.userId)).toEqual(["u-a", "u-viewer", "u-b"]);
    expect(data.rows[1]).toMatchObject({ rank: 2, username: "Vic" });
    expect(data.viewerId).toBe("u-viewer");
    expect(data.available).toBe(true);
    expect(recordBoardViewFn).toHaveBeenCalledWith(db, {
      boardKey: "members",
      scope: "overall",
      season: "all",
      resultCount: 3,
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("centers the relative board on the viewer and records the relative scope", async () => {
    const recordBoardViewFn = vi.fn(async () => {});
    const data = await loadMembersBoardData(args({ scopeParam: "relative", recordBoardViewFn }));
    expect(data.scope).toBe("relative");
    expect(data.rows.map((row) => row.userId)).toEqual(["u-a", "u-viewer", "u-b"]);
    expect(recordBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "relative", resultCount: 3 }),
    );
  });

  it("passes the season window and normalized game to the ranking read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const recordBoardViewFn = vi.fn(async () => {});
    const data = await loadMembersBoardData(
      args({
        seasonParam: "2026-Q3",
        activityParam: " Valheim ",
        loadRankingFn,
        recordBoardViewFn,
      }),
    );
    expect(data.season).toBe("2026-Q3");
    expect(data.activity).toBe("valheim");
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "window", label: "2026-Q3" }),
      "valheim",
    );
    expect(recordBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ season: "2026-Q3" }),
    );
  });

  it("answers a branded 302 for a guest before any grammar or read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    await expect(
      loadMembersBoardData(
        args({
          session: { status: "guest", userId: null, member: false },
          seasonParam: "bogus",
          loadRankingFn,
        }),
      ),
    ).rejects.toMatchObject({ status: 302 });
    expect(loadRankingFn).not.toHaveBeenCalled();
  });

  it("answers a branded 403 for a signed-in non-member before any grammar or read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    await expect(
      loadMembersBoardData(
        args({
          session: { status: "authenticated", userId: "u-x", member: false },
          seasonParam: "bogus",
          loadRankingFn,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(loadRankingFn).not.toHaveBeenCalled();
  });

  it("answers a branded 503 when the session state is unknown, never a guest bounce", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    await expect(
      loadMembersBoardData(
        args({
          session: { status: "unknown", userId: null, member: false },
          loadRankingFn,
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(loadRankingFn).not.toHaveBeenCalled();
  });

  it("answers branded 400s for bad season, scope and activity before any read", async () => {
    for (const overrides of [
      { seasonParam: "bogus" },
      { scopeParam: "friends" },
      { scopeParam: "bogus" },
      { activityParam: "chess!" },
    ]) {
      const loadRankingFn = vi.fn(async () => ranked);
      const recordBoardViewFn = vi.fn(async () => {});
      await expect(
        loadMembersBoardData(args({ ...overrides, loadRankingFn, recordBoardViewFn })),
      ).rejects.toMatchObject({ status: 400 });
      expect(loadRankingFn).not.toHaveBeenCalled();
      expect(recordBoardViewFn).not.toHaveBeenCalled();
    }
  });

  it("still serves the board when the board-view log write fails (fail-open)", async () => {
    const data = await loadMembersBoardData(
      args({
        recordBoardViewFn: async () => {
          throw new Error("locked");
        },
      }),
    );
    expect(data.rows).toHaveLength(3);
  });

  it("serves the unavailable board with no rows when no database is configured", async () => {
    const recordBoardViewFn = vi.fn(async () => {});
    // No loadRankingFn stub: the real ranking read returns [] for a null db.
    const data = await loadMembersBoardData(
      args({ dbForFn: async () => null, recordBoardViewFn, loadRankingFn: undefined }),
    );
    expect(data.available).toBe(false);
    expect(data.rows).toEqual([]);
    expect(recordBoardViewFn).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ boardKey: "members", resultCount: 0 }),
    );
  });
});
