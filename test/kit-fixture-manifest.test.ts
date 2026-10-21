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
// Playwright Kit fixture (ci/kit-worker-dev.mjs, loopback only, never
// deployed) enables just that entry for its own worker, so the journey
// executed the Kit load before the shipped manifest enabled the board. Any
// non-loopback APP_URL or a missing flag keeps the shipped manifest, and
// the fixture seam still supplies no override on a deployed APP_URL.
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

  it("requires both guards: https loopback and http non-loopback each stay rejected", () => {
    // Each case satisfies exactly one guard, so deleting either the http-only
    // protocol check or the loopback hostname allowlist alone turns one of
    // these into an override and fails this test.
    for (const APP_URL of [
      "https://127.0.0.1:8788",
      "https://localhost:8788",
      "https://[::1]:8788",
      "http://two-web-next-kit-preview.5150.workers.dev",
      "http://next.togetherweown.com",
      "http://192.168.1.10:8788",
    ]) {
      expect(
        fixtureManifestFor({ APP_URL, KIT_PARITY_FIXTURE_MEMBER_BOARD: "true" }),
        APP_URL,
      ).toBeUndefined();
    }
  });

  it("accepts the bracketed IPv6 loopback hostname URL parsing produces", () => {
    expect(
      fixtureManifestFor({
        APP_URL: "http://[::1]:8788",
        KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      }),
    ).toBeDefined();
  });

  it("clones only the member board on loopback and never mutates the shipped manifest", () => {
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
    // The shipped manifest now enables the board itself, so the fixture
    // manifest's enabled set is identical — no extra entry appears.
    expect(manifest!.filter((e) => e.enabled)).toEqual(ROUTE_MANIFEST.filter((e) => e.enabled));
    const shipped = ROUTE_MANIFEST.find(
      (e) => e.method === "GET" && e.path === "/leaderboards/members",
    );
    expect(shipped?.enabled).toBe(true);
    // No mutation: the fixture board is a clone, and every other entry is
    // the shipped object untouched.
    expect(board).not.toBe(shipped);
    expect(manifest!.filter((e) => e.path !== "/leaderboards/members")).toEqual(
      ROUTE_MANIFEST.filter((e) => e.path !== "/leaderboards/members"),
    );
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
          restoredWrite: null,
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
          restoredWrite: null,
        }),
        accessSink: async () => async () => true,
      },
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(honoFetch).not.toHaveBeenCalled();
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("supplies no fixture override on a deployed appUrl; shipped ownership serves the board", async () => {
    // The guard half: the flag still earns no override off loopback, even
    // though the shipped manifest now owns the board.
    expect(
      fixtureManifestFor({
        APP_URL: "https://next.example.test",
        KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      }),
    ).toBeUndefined();
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
          restoredWrite: null,
        }),
        accessSink: async () => async () => true,
      },
    );
    // Served by the shipped manifest (fixtureManifestFor returned no
    // override above), inside the member-read boundary.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(honoFetch).not.toHaveBeenCalled();
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await res.text()).toBe("kit board");
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
          restoredWrite: null,
        }),
        accessSink: async () => async () => true,
        afterMemberRead: (event, response) =>
          recordQueuedBoardView(event.locals, response.status, recordFn),
      },
    );
    expect(res.status).toBe(200);
    expect(recordFn).toHaveBeenCalledTimes(1);
    expect(recordFn).toHaveBeenCalledWith(
      db,
      {
        boardKey: "members",
        scope: "overall",
        season: "all",
        resultCount: 2,
      },
      undefined,
      undefined,
    );
  });
});

describe("fixtureManifestFor (event-detail RSVP companion)", () => {
  it("returns no override without either fixture flag", () => {
    expect(fixtureManifestFor({ APP_URL: "http://127.0.0.1:8788" })).toBeUndefined();
    expect(
      fixtureManifestFor({
        APP_URL: "http://127.0.0.1:8788",
        KIT_PARITY_FIXTURE_EVENT_DETAIL: "false",
      }),
    ).toBeUndefined();
  });

  it("returns no override for a deployed APP_URL even with the detail flag", () => {
    expect(
      fixtureManifestFor({
        APP_URL: "https://two-web-next-kit-preview.5150.workers.dev",
        KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
      }),
    ).toBeUndefined();
    expect(
      fixtureManifestFor({
        APP_URL: "https://next.togetherweown.com",
        KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
      }),
    ).toBeUndefined();
  });

  it("enables only the live detail entry on loopback and never mutates the shipped manifest", () => {
    const manifest = fixtureManifestFor({
      APP_URL: "http://127.0.0.1:8788",
      KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
    });
    expect(manifest).toBeDefined();
    const detail = manifest!.find((e) => e.method === "GET" && e.path === "/e/:key");
    expect(detail).toEqual({
      method: "GET",
      path: "/e/:key",
      enabled: true,
      reads: { resource: "member", action: "list", route: "events.page" },
    });
    // The shipped entry stays disabled: Hono keeps serving until the flip slice.
    expect(ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/e/:key")?.enabled).toBe(
      false,
    );
    expect(detail).not.toBe(ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/e/:key"));
    // No JSON/ICS/mutation entries appear through the fixture.
    expect(manifest!.filter((e) => /ics|json|rss|rsvp|__data/i.test(e.path))).toEqual([]);
  });

  it("enables board and detail together when both flags are set", () => {
    const manifest = fixtureManifestFor({
      APP_URL: "http://127.0.0.1:8788",
      KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
    });
    expect(
      manifest!.find((e) => e.method === "GET" && e.path === "/leaderboards/members")?.enabled,
    ).toBe(true);
    expect(manifest!.find((e) => e.method === "GET" && e.path === "/e/:key")?.enabled).toBe(true);
  });

  it("dispatches the live detail to Kit resolve under the fixture manifest", async () => {
    const manifest = fixtureManifestFor({
      APP_URL: "http://127.0.0.1:8788",
      KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
    });
    const request = new Request("http://127.0.0.1:8788/e/01ARZ3NDEKTSV4RRFFQ69G5FAV", {
      headers: { host: "127.0.0.1:8788" },
    });
    const resolve = vi.fn(async () => new Response("kit detail"));
    const honoFetch = vi.fn(async () => new Response("hono"));
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/e/[key]" } },
      {
        appUrl: "http://127.0.0.1:8788",
        honoFetch,
        resolve,
        manifest,
        eventDetail: async (_req, render) => render(),
        sessionFor: async () => ({
          status: "guest",
          session: null,
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
          restoredWrite: null,
        }),
        accessSink: async () => async () => true,
      },
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(honoFetch).not.toHaveBeenCalled();
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await res.text()).toBe("kit detail");
  });

  it("dispatches the live detail to Kit from the fixture flag alone, no manifest passed", async () => {
    const request = new Request("http://127.0.0.1:8788/e/01ARZ3NDEKTSV4RRFFQ69G5FAV", {
      headers: { host: "127.0.0.1:8788" },
    });
    const resolve = vi.fn(async () => new Response("kit detail"));
    const honoFetch = vi.fn(async () => new Response("hono"));
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/e/[key]" } },
      {
        appUrl: "http://127.0.0.1:8788",
        honoFetch,
        resolve,
        fixtureEventDetail: true,
        eventDetail: async (_req, render) => render(),
        sessionFor: async () => ({
          status: "guest",
          session: null,
          returnTo: null,
          joinResult: null,
          expiredWrite: null,
          restoredWrite: null,
        }),
        accessSink: async () => async () => true,
      },
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(honoFetch).not.toHaveBeenCalled();
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });
});
