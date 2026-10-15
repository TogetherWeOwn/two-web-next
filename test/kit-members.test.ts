import { describe, expect, it, vi } from "vitest";
import {
  loadMembersBoardData,
  queueMembersBoardView,
  recordQueuedMembersBoardView,
  type QueueBoardView,
} from "../src/kit-members";
import { memberReadResponse } from "../src/member-reads";

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
    queueBoardViewFn: () => {},
    ...overrides,
  };
}

describe("Kit member-board load parity", () => {
  it("serves the overall board, queues the anonymous board view and answers private, no-store", async () => {
    const db = {} as never;
    const queueBoardViewFn = vi.fn(() => {});
    const setHeaders = headers();
    const data = await loadMembersBoardData(
      args({ dbForFn: async () => db, queueBoardViewFn, setHeaders }),
    );
    expect(data.season).toBe("all");
    expect(data.scope).toBe("overall");
    expect(data.activity).toBeNull();
    expect(data.rows.map((row) => row.userId)).toEqual(["u-a", "u-viewer", "u-b"]);
    expect(data.rows[1]).toMatchObject({ rank: 2, username: "Vic" });
    expect(data.viewerId).toBe("u-viewer");
    expect(data.available).toBe(true);
    expect(queueBoardViewFn).toHaveBeenCalledWith(db, {
      boardKey: "members",
      scope: "overall",
      season: "all",
      resultCount: 3,
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("centers the relative board on the viewer and queues the relative scope", async () => {
    const queueBoardViewFn = vi.fn(() => {});
    const data = await loadMembersBoardData(args({ scopeParam: "relative", queueBoardViewFn }));
    expect(data.scope).toBe("relative");
    expect(data.rows.map((row) => row.userId)).toEqual(["u-a", "u-viewer", "u-b"]);
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "relative", resultCount: 3 }),
    );
  });

  it("passes the season window and normalized game to the ranking read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const queueBoardViewFn = vi.fn(() => {});
    const data = await loadMembersBoardData(
      args({
        seasonParam: "2026-Q3",
        activityParam: " Valheim ",
        loadRankingFn,
        queueBoardViewFn,
      }),
    );
    expect(data.season).toBe("2026-Q3");
    expect(data.activity).toBe("valheim");
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "window", label: "2026-Q3" }),
      "valheim",
    );
    expect(queueBoardViewFn).toHaveBeenCalledWith(
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
      const queueBoardViewFn = vi.fn(() => {});
      await expect(
        loadMembersBoardData(args({ ...overrides, loadRankingFn, queueBoardViewFn })),
      ).rejects.toMatchObject({ status: 400 });
      expect(loadRankingFn).not.toHaveBeenCalled();
      expect(queueBoardViewFn).not.toHaveBeenCalled();
    }
  });

  it("still serves the board when queueing the board view fails (fail-open)", async () => {
    const data = await loadMembersBoardData(
      args({
        queueBoardViewFn: () => {
          throw new Error("locked");
        },
      }),
    );
    expect(data.rows).toHaveLength(3);
  });

  it("serves the unavailable board with no rows when no database is configured", async () => {
    const queueBoardViewFn = vi.fn(() => {});
    // No loadRankingFn stub: the real ranking read returns [] for a null db.
    const data = await loadMembersBoardData(
      args({ dbForFn: async () => null, queueBoardViewFn, loadRankingFn: undefined }),
    );
    expect(data.available).toBe(false);
    expect(data.rows).toEqual([]);
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ boardKey: "members", resultCount: 0 }),
    );
  });

  it("does not itself write the board view: the queued entry waits for the post-release record", async () => {
    const recordBoardViewFn = vi.fn(async () => {});
    const locals: Record<string, unknown> = {};
    const data = await loadMembersBoardData(
      args({
        queueBoardViewFn: ((db, entry) =>
          queueMembersBoardView(locals, db, entry)) satisfies QueueBoardView,
      }),
    );
    expect(data.rows).toHaveLength(3);
    expect(recordBoardViewFn).not.toHaveBeenCalled();
    await recordQueuedMembersBoardView(locals, 200, recordBoardViewFn);
    expect(recordBoardViewFn).toHaveBeenCalledTimes(1);
    expect(recordBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ boardKey: "members", resultCount: 3 }),
    );
    // The stash is consumed: a second release record writes nothing more.
    await recordQueuedMembersBoardView(locals, 200, recordBoardViewFn);
    expect(recordBoardViewFn).toHaveBeenCalledTimes(1);
  });

  it("drops the queued board view when the boundary did not release a 200", async () => {
    const recordBoardViewFn = vi.fn(async () => {});
    const locals: Record<string, unknown> = {};
    queueMembersBoardView(locals, {} as never, {
      boardKey: "members",
      scope: "overall",
      season: "all",
      resultCount: 3,
    });
    await recordQueuedMembersBoardView(locals, 503, recordBoardViewFn);
    expect(recordBoardViewFn).not.toHaveBeenCalled();
    await recordQueuedMembersBoardView(locals, 200, recordBoardViewFn);
    expect(recordBoardViewFn).not.toHaveBeenCalled();
  });

  it("a failing post-release board-view write never throws (fail-open)", async () => {
    const locals: Record<string, unknown> = {};
    queueMembersBoardView(locals, {} as never, {
      boardKey: "members",
      scope: "overall",
      season: "all",
      resultCount: 1,
    });
    await expect(
      recordQueuedMembersBoardView(locals, 200, async () => {
        throw new Error("locked");
      }),
    ).resolves.toBeUndefined();
  });

  it("memberReadResponse runs the post-release hook only after a released 200", async () => {
    const sink = vi.fn(async () => true);
    const afterRelease = vi.fn(async (_response: Response) => {});
    const released = await memberReadResponse(
      { method: "GET", route: "/leaderboards/members" },
      {
        resource: "leaderboard",
        action: "list",
        route: "leaderboards.members",
        viewer: "100000000000000101",
      },
      sink,
      async () => new Response("<h1>Member leaderboard</h1>", { status: 200 }),
      afterRelease,
    );
    expect(released.status).toBe(200);
    expect(afterRelease).toHaveBeenCalledTimes(1);
    expect(afterRelease.mock.calls[0]![0].status).toBe(200);

    const refusedAfter = vi.fn(async (_response: Response) => {});
    const refused = await memberReadResponse(
      { method: "GET", route: "/leaderboards/members" },
      () => undefined,
      sink,
      async () => new Response("<h1>Member leaderboard</h1>", { status: 200 }),
      refusedAfter,
    );
    expect(refused.status).toBe(503);
    expect(refusedAfter).not.toHaveBeenCalled();
  });
});
