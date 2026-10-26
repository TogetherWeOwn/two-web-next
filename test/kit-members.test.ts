import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import {
  loadMembersBoardData,
  queueMembersBoardView,
  recordQueuedMembersBoardView,
  type QueueBoardView,
  type RecordBoardView,
} from "../src/kit-members";
import { memberReadResponse } from "../src/member-reads";

// Minimal real catalog fixture: the board now reads published games once per
// render via the exact published-games statement. An empty pg-proxy DB answers
// that read with no games without faking success or swallowing programming
// errors; ranking stays stubbed per-test.
const emptyCatalogDb = () => drizzle(async () => ({ rows: [] }));

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
    dbForFn: async () => emptyCatalogDb() as never,
    loadRankingFn: async () => ranked,
    queueBoardViewFn: () => {},
    ...overrides,
  };
}

describe("Kit member-board load parity", () => {
  it("serves the overall board, queues the anonymous board view and answers private, no-store", async () => {
    const db = emptyCatalogDb() as never;
    const queueBoardViewFn = vi.fn(() => {});
    const setHeaders = headers();
    const data = await loadMembersBoardData(
      args({ dbForFn: async () => db, queueBoardViewFn, setHeaders }),
    );
    expect(data.season).toBe("all");
    expect(data.scope).toBe("overall");
    expect(data.activity).toBeNull();
    expect(data.rows.map((row) => row.username)).toEqual(["Ana", "Vic", "Bo"]);
    expect(data.rows.map((row) => row.isViewer)).toEqual([false, true, false]);
    expect(data.rows[1]).toMatchObject({ rank: 2, username: "Vic", isViewer: true });
    expect("viewerId" in data).toBe(false);
    expect(data.available).toBe(true);
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      db,
      {
        boardKey: "members",
        scope: "overall",
        season: "all",
        resultCount: 3,
      },
      undefined,
    );
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("serves the pre-ranked relative window and marks the viewer", async () => {
    // The relative read centers the window in SQL and returns BoardRows, so
    // the load passes the window through and only marks the viewer: no
    // re-slicing here (the window shape is pinned through the real read by
    // the relative-board acceptance suites).
    const queueBoardViewFn = vi.fn(() => {});
    const window = [
      { userId: "u-a", username: "Ana", count: 5, rank: 1 },
      { userId: "u-viewer", username: "Vic", count: 3, rank: 2 },
      { userId: "u-b", username: "Bo", count: 1, rank: 3 },
    ];
    const loadRankingFn = vi.fn(async () => window);
    const data = await loadMembersBoardData(
      args({ scopeParam: "relative", queueBoardViewFn, loadRankingFn }),
    );
    expect(data.scope).toBe("relative");
    expect(loadRankingFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      "relative",
      "u-viewer",
    );
    expect(data.rows).toEqual([
      { rank: 1, username: "Ana", count: 5, isViewer: false },
      { rank: 2, username: "Vic", count: 3, isViewer: true },
      { rank: 3, username: "Bo", count: 1, isViewer: false },
    ]);
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "relative", resultCount: 3 }),
      undefined,
    );
  });

  it("serializes no Discord IDs for the __data.json payload (viewer marked server-side)", async () => {
    // SvelteKit serves GET /leaderboards/members/__data.json from this load's
    // return value even with csr = false, so the serialized load output must
    // carry rank + display name + count + isViewer only: no ranked member's
    // Discord ID and no viewerId (src/leaderboards/members.ts data rule).
    const data = await loadMembersBoardData(args());
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("viewerId");
    for (const id of ["u-a", "u-viewer", "u-b"]) expect(serialized).not.toContain(id);
    expect(data.rows).toEqual([
      { rank: 1, username: "Ana", count: 5, isViewer: false },
      { rank: 2, username: "Vic", count: 3, isViewer: true },
      { rank: 3, username: "Bo", count: 1, isViewer: false },
    ]);
  });

  it("moves the viewer mark when a different viewer loads the board", async () => {
    const data = await loadMembersBoardData(args({ session: { ...memberSession, userId: "u-a" } }));
    expect(data.rows.map((row) => row.username)).toEqual(["Ana", "Vic", "Bo"]);
    expect(data.rows.map((row) => row.isViewer)).toEqual([true, false, false]);
    expect(data.rows[0]).toMatchObject({ rank: 1, username: "Ana", isViewer: true });
    expect("viewerId" in data).toBe(false);
    expect(JSON.stringify(data)).not.toContain("u-a");
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
      "overall",
      "u-viewer",
    );
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ season: "2026-Q3" }),
      undefined,
    );
  });

  it("answers a branded 302 for a guest before any grammar or read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const setHeaders = headers();
    await expect(
      loadMembersBoardData(
        args({
          session: { status: "guest", userId: null, member: false },
          seasonParam: "bogus",
          loadRankingFn,
          setHeaders,
        }),
      ),
    ).rejects.toMatchObject({ status: 302 });
    expect(loadRankingFn).not.toHaveBeenCalled();
    expect(setHeaders).not.toHaveBeenCalled();
  });

  it("answers a branded 403 for a signed-in non-member before any grammar or read", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const setHeaders = headers();
    await expect(
      loadMembersBoardData(
        args({
          session: { status: "authenticated", userId: "u-x", member: false },
          seasonParam: "bogus",
          loadRankingFn,
          setHeaders,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(loadRankingFn).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("answers a branded 503 when the session state is unknown, never a guest bounce", async () => {
    const loadRankingFn = vi.fn(async () => ranked);
    const setHeaders = headers();
    await expect(
      loadMembersBoardData(
        args({
          session: { status: "unknown", userId: null, member: false },
          loadRankingFn,
          setHeaders,
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(loadRankingFn).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("answers branded 400s for bad season, scope and activity before any read", async () => {
    for (const overrides of [
      { seasonParam: "bogus" },
      { scopeParam: "friends" },
      { scopeParam: "bogus" },
      { activityParam: "chess\u0000" },
    ]) {
      const dbForFn = vi.fn(async () => ({}) as never);
      const loadRankingFn = vi.fn(async () => ranked);
      const queueBoardViewFn = vi.fn(() => {});
      const setHeaders = headers();
      await expect(
        loadMembersBoardData(
          args({ ...overrides, dbForFn, loadRankingFn, queueBoardViewFn, setHeaders }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(dbForFn).not.toHaveBeenCalled();
      expect(loadRankingFn).not.toHaveBeenCalled();
      expect(queueBoardViewFn).not.toHaveBeenCalled();
      expect(setHeaders).toHaveBeenCalledTimes(1);
      expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
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
      undefined,
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
      undefined,
      undefined,
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

  it("a throwing post-release hook never replaces the released 200", async () => {
    const sink = vi.fn(async () => true);
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
      async () => {
        throw new Error("board-view write failed");
      },
    );
    expect(released.status).toBe(200);
    expect(await released.text()).toBe("<h1>Member leaderboard</h1>");
  });
});

describe("Kit member-board request id", () => {
  const VALID_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const entry = { boardKey: "members", scope: "overall", season: "all", resultCount: 3 };

  it("forwards a caller-supplied request id to the queue call", async () => {
    const queueBoardViewFn = vi.fn(() => {});
    await loadMembersBoardData(args({ queueBoardViewFn, requestId: VALID_ID }));
    expect(queueBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ boardKey: "members" }),
      VALID_ID,
    );
  });

  it("omits the request id the caller does not supply", async () => {
    const queueBoardViewFn = vi.fn<QueueBoardView>(() => {});
    await loadMembersBoardData(args({ queueBoardViewFn }));
    expect(queueBoardViewFn).toHaveBeenCalledTimes(1);
    expect(queueBoardViewFn.mock.calls[0]![2]).toBeUndefined();
  });

  it("a queued request id rides along to the post-release record", async () => {
    const recordBoardViewFn = vi.fn(async () => {});
    const locals: Record<string, unknown> = {};
    queueMembersBoardView(locals, {} as never, entry, VALID_ID);
    await recordQueuedMembersBoardView(locals, 200, recordBoardViewFn);
    expect(recordBoardViewFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ boardKey: "members" }),
      undefined,
      VALID_ID,
    );
  });

  it("an unqueued request id reaches the record call as undefined", async () => {
    const recordBoardViewFn = vi.fn<RecordBoardView>(async () => {});
    const locals: Record<string, unknown> = {};
    queueMembersBoardView(locals, {} as never, entry);
    await recordQueuedMembersBoardView(locals, 200, recordBoardViewFn);
    expect(recordBoardViewFn).toHaveBeenCalledTimes(1);
    expect(recordBoardViewFn.mock.calls[0]![3]).toBeUndefined();
  });
});
