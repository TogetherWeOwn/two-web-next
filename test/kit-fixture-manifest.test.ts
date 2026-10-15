import { describe, expect, it, vi } from "vitest";
import { queueBoardView, recordQueuedBoardView } from "../src/hotzones/board-log";
import {
  dispatchHookRequest,
  fixtureManifestFor,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
} from "../src/route-ownership";

// Fixture-only ownership for the executed member-board parity journey: the
// shipped manifest holds /leaderboards/members on Hono until the privacy
// verdict, so the Playwright Kit fixture (ci/kit-worker-dev.mjs, loopback
// only, never deployed) enables just that entry for its own worker. Any
// non-loopback APP_URL or a missing flag keeps the shipped manifest.
describe("fixtureManifestFor (Kit parity fixture only)", () => {
  it("returns no override without the fixture flag", () => {
    expect(fixtureManifestFor({ APP_URL: "http://127.0.0.1:8788" })).toBeUndefined();
    expect(
      fixtureManifestFor({
        APP_URL: "http://127.0.0.1:8788",
        KIT_PARITY_FIXTURE_MEMBER_BOARD: "false",
      }),
    ).toBeUndefined();
  });

  it("returns no override for a deployed (non-loopback) APP_URL even with the flag", () => {
    expect(
      fixtureManifestFor({
        APP_URL: "https://two-web-next-kit-preview.5150.workers.dev",
        KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      }),
    ).toBeUndefined();
    expect(
      fixtureManifestFor({
        APP_URL: "https://next.togetherweown.com",
        KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      }),
    ).toBeUndefined();
  });

  it("accepts the bracketed IPv6 loopback hostname URL parsing produces", () => {
    expect(
      fixtureManifestFor({
        APP_URL: "http://[::1]:8788",
        KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      }),
    ).toBeDefined();
  });

  it("enables only the member board on loopback and never mutates the shipped manifest", () => {
    const manifest = fixtureManifestFor({
      APP_URL: "http://127.0.0.1:8788",
      KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
    });
    expect(manifest).toBeDefined();
    const board = manifest!.find((e) => e.method === "GET" && e.path === "/leaderboards/members");
    expect(board).toEqual({
      method: "GET",
      path: "/leaderboards/members",
      enabled: true,
      reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" },
    });
    expect(manifest!.filter((e) => e.enabled)).toEqual(
      ROUTE_MANIFEST.filter((e) => e.enabled).concat(board!),
    );
    expect(
      ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/leaderboards/members")?.enabled,
    ).toBe(false);
  });

  it("dispatches the member board to Kit resolve under the fixture manifest", async () => {
    const manifest = fixtureManifestFor({
      APP_URL: "http://127.0.0.1:8788",
      KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
    });
    const request = new Request("http://127.0.0.1:8788/leaderboards/members", {
      headers: { host: "127.0.0.1:8788" },
    });
    const resolve = vi.fn(async () => new Response("kit board"));
    const honoFetch = vi.fn(async () => new Response("hono"));
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/leaderboards/members" } },
      {
        appUrl: "http://127.0.0.1:8788",
        honoFetch,
        resolve,
        manifest,
        sessionFor: async () => ({
          status: "authenticated",
          session: {
            userId: "100000000000000101",
            username: "zxq-fixture-member",
            avatar: null,
            member: true,
            moderator: false,
          },
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
        }),
        accessSink: async () => async () => true,
      },
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(honoFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await res.text()).toBe("kit board");
  });

  it("dispatches the member board to Kit from the fixture flag alone, no manifest passed", async () => {
    // The hook is a pure env binding (test/hook-route-ownership.test.mjs pins
    // it carries no manifest seam): it forwards only the boolean flag, and
    // the core turns flag + loopback appUrl into the fixture route choice.
    const request = new Request("http://127.0.0.1:8788/leaderboards/members", {
      headers: { host: "127.0.0.1:8788" },
    });
    const resolve = vi.fn(async () => new Response("kit board"));
    const honoFetch = vi.fn(async () => new Response("hono"));
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/leaderboards/members" } },
      {
        appUrl: "http://127.0.0.1:8788",
        honoFetch,
        resolve,
        fixtureMemberBoard: true,
        sessionFor: async () => ({
          status: "authenticated",
          session: {
            userId: "100000000000000101",
            username: "zxq-fixture-member",
            avatar: null,
            member: true,
            moderator: false,
          },
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
        }),
        accessSink: async () => async () => true,
      },
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(honoFetch).not.toHaveBeenCalled();
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("keeps the member board on Hono when the fixture flag meets a deployed appUrl", async () => {
    const request = new Request("https://next.example.test/leaderboards/members", {
      headers: { host: "next.example.test" },
    });
    const resolve = vi.fn(async () => new Response("kit board"));
    const honoFetch = vi.fn(async () => new Response("hono"));
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/leaderboards/members" } },
      {
        appUrl: "https://next.example.test",
        honoFetch,
        resolve,
        fixtureMemberBoard: true,
      },
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(honoFetch).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("hono");
  });

  it("records the board view queued by the load only after the boundary releases the 200", async () => {
    const manifest = fixtureManifestFor({
      APP_URL: "http://127.0.0.1:8788",
      KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
    });
    const recordFn = vi.fn(async () => {});
    const db = {} as never;
    const request = new Request("http://127.0.0.1:8788/leaderboards/members", {
      headers: { host: "127.0.0.1:8788" },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/leaderboards/members" } },
      {
        appUrl: "http://127.0.0.1:8788",
        honoFetch: vi.fn(async () => new Response("hono")),
        resolve: vi.fn(async (event) => {
          // The Kit binding queues the view into locals during the load;
          // nothing is written while the render is inside the capture.
          queueBoardView(event.locals, db, {
            boardKey: "members",
            scope: "overall",
            season: "all",
            resultCount: 2,
          });
          expect(recordFn).not.toHaveBeenCalled();
          return new Response("kit board");
        }),
        manifest,
        sessionFor: async () => ({
          status: "authenticated",
          session: {
            userId: "100000000000000101",
            username: "zxq-fixture-member",
            avatar: null,
            member: true,
            moderator: false,
          },
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
        }),
        accessSink: async () => async () => true,
        afterMemberRead: (event, response) =>
          recordQueuedBoardView(event.locals, response.status, recordFn),
      },
    );
    expect(res.status).toBe(200);
    expect(recordFn).toHaveBeenCalledTimes(1);
    expect(recordFn).toHaveBeenCalledWith(db, {
      boardKey: "members",
      scope: "overall",
      season: "all",
      resultCount: 2,
    });
  });
});
