// Member-board enablement acceptance: the shipped manifest owns
// GET /leaderboards/members on Kit.
//
// Enablement flips exactly one entry (`enabled: false` -> `true`) with the
// same member-read declaration; every membership/opt-out/audit/private-cache
// control stays unchanged, and returning the entry to `enabled: false`
// restores Hono ownership as the rollback. These cases pin the shipped
// manifest (no override) so they fail while the board is held on Hono and
// pass once the enablement lands. Test files only: no source changes here.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadMembersBoardData } from "../src/kit-members";
import {
  decideRoute,
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  resolveRouteOwner,
  ROUTE_MANIFEST,
  type OwnedRoute,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const BOARD_DECLARATION = {
  resource: "leaderboard",
  action: "list",
  route: "leaderboards.members",
} as const;

const get = (path: string) => new Request(new URL(path, APP_URL).href, { method: "GET" });

const eventFor = (path: string, method = "GET") => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: path } };
};

const depsFor = () => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: vi.fn(async () => new Response("kit")),
});

const memberDeps = () => ({
  ...depsFor(),
  sessionFor: async () => ({
    status: "authenticated" as const,
    session: {
      userId: "100000000000000301",
      username: "zxq-board-member",
      avatar: null,
      member: true,
      moderator: false,
    },
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  }),
  accessSink: async () => async () => true,
});

const env = { APP_URL: "https://example.test" } as never;
const boardArgs = (overrides: Record<string, unknown> = {}) => ({
  env,
  session: { status: "authenticated" as const, userId: "u-viewer", member: true },
  seasonParam: null,
  scopeParam: null,
  activityParam: null,
  setHeaders: vi.fn((_headers: Record<string, string>) => {}),
  dbForFn: async () => ({}) as never,
  loadRankingFn: async () => [{ userId: "u-viewer", username: "Vic", count: 3 }],
  queueBoardViewFn: () => {},
  ...overrides,
});

describe("member-board enablement acceptance (shipped manifest)", () => {
  it("owns GET /leaderboards/members on Kit", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/leaderboards/members" })).toBe("kit");
  });

  it("lets HEAD follow the GET entry to Kit and keeps POST on Hono", () => {
    expect(resolveRouteOwner({ method: "HEAD", path: "/leaderboards/members" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/leaderboards/members" })).toBe("hono");
  });

  it("treats the Kit data request like its page", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/leaderboards/members/__data.json" })).toBe(
      "kit",
    );
  });

  it("declares the exact member read on the Kit decision", () => {
    expect(decideRoute(get("/leaderboards/members"))?.reads).toEqual({ ...BOARD_DECLARATION });
  });

  it("ships the enabled board entry with the exact method/path/reads", () => {
    const entry = ROUTE_MANIFEST.find(
      (e) => e.method === "GET" && e.path === "/leaderboards/members",
    );
    expect(entry, "missing manifest entry GET /leaderboards/members").toBeDefined();
    expect(entry?.enabled).toBe(true);
    expect(entry?.reads).toEqual({ ...BOARD_DECLARATION });
  });

  it("dispatches the board to resolve inside the member-read boundary, never to Hono", async () => {
    const event = eventFor("/leaderboards/members");
    const deps = memberDeps();
    const response = await dispatchHookRequest(event, deps);
    expect(deps.resolve).toHaveBeenCalledOnce();
    expect(deps.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("rollback: a disabled copy restores Hono ownership for GET, HEAD and data requests", () => {
    const rolledBack: OwnedRoute[] = ROUTE_MANIFEST.map((entry) =>
      entry.method === "GET" && entry.path === "/leaderboards/members"
        ? { ...entry, enabled: false }
        : entry,
    );
    expect(
      rolledBack.find((e) => e.method === "GET" && e.path === "/leaderboards/members")?.enabled,
    ).toBe(false);
    for (const decision of [
      { method: "GET", path: "/leaderboards/members" },
      { method: "HEAD", path: "/leaderboards/members" },
      { method: "GET", path: "/leaderboards/members/__data.json" },
      { method: "POST", path: "/leaderboards/members" },
    ]) {
      expect(resolveRouteOwner(decision, rolledBack), `${decision.method} ${decision.path}`).toBe(
        "hono",
      );
    }
    expect(decideRoute(get("/leaderboards/members"), rolledBack)).toBeUndefined();
  });

  it("keeps the member gate first: guest 302, non-member 403, unknown 503, all before any read", async () => {
    for (const [session, status] of [
      [{ status: "guest", userId: null, member: false }, 302],
      [{ status: "authenticated", userId: "u-viewer", member: false }, 403],
      [{ status: "unknown", userId: null, member: false }, 503],
    ] as const) {
      const loadRankingFn = vi.fn(async () => []);
      await expect(
        loadMembersBoardData(boardArgs({ session, seasonParam: "bogus", loadRankingFn })),
      ).rejects.toMatchObject({ status });
      expect(loadRankingFn).not.toHaveBeenCalled();
    }
  });

  it("keeps query grammar before any read: bad season, scope and activity answer 400", async () => {
    for (const params of [
      { seasonParam: "bogus" },
      { scopeParam: "friends" },
      { scopeParam: "nope" },
      { activityParam: "!!!" },
    ]) {
      const loadRankingFn = vi.fn(async () => []);
      await expect(
        loadMembersBoardData(boardArgs({ ...params, loadRankingFn })),
      ).rejects.toMatchObject({ status: 400 });
      expect(loadRankingFn).not.toHaveBeenCalled();
    }
  });

  it("keeps the private cache and fail-open queue: one private,no-store set, a throwing queue still serves", async () => {
    const setHeaders = vi.fn((_headers: Record<string, string>) => {});
    const data = await loadMembersBoardData(
      boardArgs({
        setHeaders,
        queueBoardViewFn: () => {
          throw new Error("queue down");
        },
      }),
    );
    expect(data.rows.length).toBeGreaterThan(0);
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("keeps every membership/opt-out/audit/private-cache control in source", () => {
    const ranking = readFileSync("src/leaderboards/members.ts", "utf8");
    expect(ranking).toContain("profiles.leaderboardOptOut");
    expect(ranking).toContain(".innerJoin(users, eq(users.id, rsvps.userId))");
    expect(ranking).toContain("eq(users.member, true)");
    const hono = readFileSync("src/leaderboards/routes.tsx", "utf8");
    expect(hono).toContain("app.use(MEMBER_BOARD_PATH, memberGate(deps))");
    expect(hono).toContain("await memberReadBoundary(");
    expect(hono).toContain('route: "leaderboards.members"');
    expect(hono).toContain("await recordBoardView(db, entry).catch(() => {});");
    const kit = readFileSync("src/kit-members.ts", "utf8");
    expect(kit).toContain('args.setHeaders({ "cache-control": "private, no-store" })');
    expect(kit).toContain("queueBoardViewFn?.(db,");
  });
});
