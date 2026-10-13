// Dispatch ownership proof for the hot-zone + member-board Kit migration.
//
// Kit SSR serves /hotzones, /hotzones/:signal (joins|voice|
// games) and /leaderboards/members. Shell existence does not prove ownership:
// only the shipped ROUTE_MANIFEST decision does. These cases pin the shipped
// manifest (no override) so flipping `enabled` flips the gate for the right
// reason. They fail while the manifest has no entries (Hono fallback) and
// pass once the exact method/paths are Kit-owned with the correct reads.
import { describe, expect, it, vi } from "vitest";
import {
  decideRoute,
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  resolveRouteOwner,
  ROUTE_MANIFEST,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";

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

describe("hot-zone + member-board Kit ownership (shipped manifest)", () => {
  it.each(["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"])(
    "owns GET %s on Kit",
    (path) => {
      expect(resolveRouteOwner({ method: "GET", path })).toBe("kit");
    },
  );

  it("owns GET /leaderboards/members on Kit", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/leaderboards/members" })).toBe("kit");
  });

  it("keeps the control /events/past on Kit and still-disabled leaves on Hono", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/privacy" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/join" })).toBe("hono");
  });

  it("declares public reads for hot-zones and a member read for the board", () => {
    expect(decideRoute(get("/hotzones"))?.reads).toBe("public");
    expect(decideRoute(get("/hotzones/joins"))?.reads).toBe("public");
    expect(decideRoute(get("/hotzones/voice"))?.reads).toBe("public");
    expect(decideRoute(get("/hotzones/games"))?.reads).toBe("public");
    expect(decideRoute(get("/leaderboards/members"))?.reads).toEqual({
      resource: "leaderboard",
      action: "list",
      route: "leaderboards.members",
    });
  });

  it("lets HEAD follow the GET entry and keeps POST on Hono", () => {
    expect(resolveRouteOwner({ method: "HEAD", path: "/hotzones" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/leaderboards/members" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/hotzones" })).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/leaderboards/members" })).toBe("hono");
  });

  it("treats Kit data requests like their pages", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/hotzones/__data.json" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/leaderboards/members/__data.json" })).toBe(
      "kit",
    );
  });

  it("answers /hotzones/bogus on Hono (unknown signals never claim a grid)", () => {
    // Concrete signal entries only: no :param pattern claims siblings, so an
    // unknown segment falls through to the Hono 404 instead of Kit.
    expect(resolveRouteOwner({ method: "GET", path: "/hotzones/bogus" })).toBe("hono");
  });

  it("dispatches a Kit-owned hot-zone request to resolve with the Kit marker", async () => {
    const event = eventFor("/hotzones/joins");
    const deps = depsFor();
    const response = await dispatchHookRequest(event, deps);
    expect(deps.resolve).toHaveBeenCalledOnce();
    expect(deps.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await response.text()).toBe("kit");
  });

  it("dispatches the member board to resolve (member-read boundary) and Hono control to honoFetch", async () => {
    const board = eventFor("/leaderboards/members");
    const boardDeps = {
      ...depsFor(),
      sessionFor: async () => ({
        status: "authenticated" as const,
        session: {
          userId: "100000000000000301",
          username: "zxq-dispatch-member",
          avatar: null,
          member: true,
          moderator: false,
        },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
      }),
      accessSink: async () => null,
    };
    // No access-log sink: the member-read boundary refuses with 503, but the
    // refusal still proves Kit owned the dispatch (resolve attempted inside
    // the boundary, honoFetch never ran).
    const refused = await dispatchHookRequest(board, boardDeps);
    expect(boardDeps.honoFetch).not.toHaveBeenCalled();
    expect([503, 200]).toContain(refused.status);

    const control = eventFor("/privacy");
    const controlDeps = depsFor();
    const hono = await dispatchHookRequest(control, controlDeps);
    expect(controlDeps.honoFetch).toHaveBeenCalledOnce();
    expect(controlDeps.resolve).not.toHaveBeenCalled();
    expect(hono.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("ships the new entries in ROUTE_MANIFEST with the exact method/paths", () => {
    for (const path of [
      "/hotzones",
      "/hotzones/joins",
      "/hotzones/voice",
      "/hotzones/games",
      "/leaderboards/members",
    ]) {
      const entry = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === path);
      expect(entry, `missing manifest entry GET ${path}`).toBeDefined();
      expect(entry?.enabled).toBe(true);
    }
  });
});
