// Implementation-owned pins for Kit error request correlation. The
// failing-first acceptance suite (test/kit-error-request-correlation.test.ts,
// owned by the acceptance card) pins the shell markup, the boundary
// threading and the dispatch header contract; this file pins the links the
// Builder added around it: the Kit same-origin refusal carries an id, the
// member-read boundary alerts with the served id, the load helpers forward
// the binding's id to their error.alert lines, the guard-built 429 pages
// render the dispatch id as their support reference, and the Hono-fallback
// return keeps Hono's own header untouched. Hermetic: local fixtures only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { loadActivityLogPage } from "../src/admin/kit-activity-log";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { dispatchEventDetailRequest } from "../src/events/kit-detail";
import { GUARD_REQUEST_ID_HEADER } from "../src/events/routes-shared";
import { dispatchEventsRequest, kitEventsGuard } from "../src/kit-events";
import { dispatchHotzonesRequest, loadHotzonesIndexData } from "../src/kit-hotzones";
import { loadMembersBoardData } from "../src/kit-members";
import { dispatchPastArchiveRequest, kitPublicReadGuard } from "../src/kit-past-events";
import { safeRequestId } from "../src/request-log";
import {
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
  type RouteReads,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const HOST = "next.example.test";
const RAY = "0123456789abcdef-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const env = { APP_URL: "https://example.test" } as unknown as Env;

function alertLines(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.includes('"error.alert"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Kit dispatch correlation around the acceptance contract", () => {
  it("Kit same-origin refusal carries a generated x-request-id", async () => {
    const request = new Request(new URL("/about", APP_URL).href, {
      method: "POST",
      headers: { host: HOST, origin: "https://evil.example" },
    });
    const resolve = vi.fn(async () => new Response("must not resolve", { status: 500 }));
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/about" } },
      {
        appUrl: APP_URL,
        manifest: [{ method: "POST", path: "/about", enabled: true, reads: "public" }],
        honoFetch: async () => new Response("must not hono", { status: 500 }),
        resolve,
      },
    );
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    const header = res.headers.get("x-request-id");
    expect(header, "x-request-id is set").toBeTruthy();
    expect(header!).toMatch(ULID);
    expect(safeRequestId(header)).toBe(header);
    expect(res.headers.get("x-two-renderer")).toBe("kit");
  });

  it("member-read failure alerts with the served request id", async () => {
    const request = new Request(new URL("/admin/join-attempts", APP_URL).href, {
      headers: { host: HOST, "cf-ray": RAY },
    });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin/join-attempts" },
    };
    const res = await dispatchHookRequest(event, {
      appUrl: APP_URL,
      manifest: [
        {
          method: "GET",
          path: "/admin/join-attempts",
          enabled: true,
          reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
        },
      ],
      honoFetch: async () => new Response("must not hono", { status: 500 }),
      resolve: async () => {
        throw new TypeError("probe: cannot read properties of undefined");
      },
      accessSink: async () => async () => true,
    });
    expect(res.status).toBe(503);
    const header = res.headers.get("x-request-id");
    expect(header).toBe(RAY);
    const lines = alertLines();
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    expect(lines[0]!.event).toBe("error.alert");
    expect(lines[0]!.request_id).toBe(header);
  });

  it("Hono-fallback return keeps Hono's own header untouched", async () => {
    const honoId = "01ARYZ6S41AAAAAAAAAAAAAAAA";
    const request = new Request(new URL("/about", APP_URL).href, {
      headers: { host: HOST, "cf-ray": RAY },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/[...path]" } },
      {
        appUrl: APP_URL,
        manifest: [{ method: "GET", path: "/about", enabled: true, reads: "public" }],
        honoFetch: async () => new Response("must not hono", { status: 500 }),
        resolve: async () =>
          new Response("<html>hono</html>", {
            status: 200,
            headers: { "content-type": "text/html", "x-request-id": honoId },
          }),
      },
    );
    // Hono answering through Kit: its middleware-set header stands, and the
    // response carries neither the Kit marker nor the dispatch id.
    expect(res.headers.get("x-request-id")).toBe(honoId);
    expect(res.headers.get("x-two-renderer")).toBeNull();
  });
});

describe("Kit load helpers forward the binding request id to error.alert", () => {
  it("hotzones load failure names the passed request id", async () => {
    const setHeaders = vi.fn((_headers: Record<string, string>) => {});
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: null,
        setHeaders,
        dbForFn: async () => ({}) as unknown as Db,
        loadJoinsGridFn: async () => {
          throw new TypeError("probe: cannot read properties of undefined");
        },
        requestId: RAY,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const lines = alertLines();
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    expect(lines[0]!.request_id).toBe(RAY);
  });

  it("members board failure names the passed request id", async () => {
    const setHeaders = vi.fn((_headers: Record<string, string>) => {});
    await expect(
      loadMembersBoardData({
        env,
        session: { status: "authenticated", userId: "u-viewer", member: true },
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders,
        dbForFn: async () => ({}) as unknown as Db,
        loadRankingFn: async () => {
          throw new TypeError("probe: cannot read properties of undefined");
        },
        queueBoardViewFn: () => {},
        requestId: RAY,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const lines = alertLines();
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    expect(lines[0]!.request_id).toBe(RAY);
  });

  it("activity-log load failure names the passed request id", async () => {
    const setHeaders = vi.fn((_headers: Record<string, string>) => {});
    await expect(
      loadActivityLogPage({
        env,
        subjectParam: null,
        causerParam: null,
        pageParam: null,
        setHeaders,
        dbForFn: async () => ({}) as unknown as Db,
        listFn: async () => {
          throw new TypeError("probe: cannot read properties of undefined");
        },
        requestId: RAY,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const lines = alertLines();
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    expect(lines[0]!.request_id).toBe(RAY);
  });
});

describe("Kit guard 429s render the dispatch support reference", () => {
  // Exhausted throttle-store double (same shape as
  // test/kit-past-events.test.ts): the shared budget reports over-limit so
  // the real guard chain refuses with the Hono 429 page.
  function throttledEnv(): Env {
    let sql: ((parts: TemplateStringsArray) => Promise<unknown[]>) & {
      begin: (run: (tx: never) => Promise<unknown>) => Promise<unknown>;
    };
    sql = Object.assign(
      vi.fn(async (parts: TemplateStringsArray) =>
        parts.join("").includes("SELECT count(*)") ? [{ n: 60, wait: 12 }] : [],
      ),
      {
        begin: async (run: (tx: never) => Promise<unknown>) => run(sql as never),
        unsafe: async () => [],
      },
    );
    return { APP_URL: "https://example.test", THROTTLE_STORE: async () => sql } as never;
  }

  function supportReferenceOf(html: string): string | null {
    return html.match(/data-testid="error-support-reference">([^<]*)<\/code>/)?.[1] ?? null;
  }

  it("throttled past-archive 429 body names the admitted cf-ray", async () => {
    const request = new Request(new URL("/events/past", APP_URL).href, {
      headers: { host: HOST, "cf-ray": RAY },
    });
    const resolve = vi.fn(async () => new Response("must not resolve", { status: 500 }));
    const store = throttledEnv();
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/events/past" } },
      {
        appUrl: APP_URL,
        manifest: [{ method: "GET", path: "/events/past", enabled: true, reads: "public" }],
        honoFetch: async () => new Response("must not hono", { status: 500 }),
        resolve,
        pastArchive: (req, render, requestId) =>
          dispatchPastArchiveRequest(req, store, render, undefined, undefined, requestId),
      },
    );
    expect(res.status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
    expect(res.headers.get("x-two-renderer")).toBe("kit");
    const header = res.headers.get("x-request-id");
    expect(header).toBe(RAY);
    const body = await res.text();
    expect(supportReferenceOf(body)).toBe(header);
  });

  it("throttled past-archive 429 body names the minted id when no cf-ray", async () => {
    const request = new Request(new URL("/events/past", APP_URL).href, {
      headers: { host: HOST },
    });
    const resolve = vi.fn(async () => new Response("must not resolve", { status: 500 }));
    const store = throttledEnv();
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/events/past" } },
      {
        appUrl: APP_URL,
        manifest: [{ method: "GET", path: "/events/past", enabled: true, reads: "public" }],
        honoFetch: async () => new Response("must not hono", { status: 500 }),
        resolve,
        pastArchive: (req, render, requestId) =>
          dispatchPastArchiveRequest(req, store, render, undefined, undefined, requestId),
      },
    );
    expect(res.status).toBe(429);
    const header = res.headers.get("x-request-id");
    expect(header, "x-request-id is set").toBeTruthy();
    expect(header!).toMatch(ULID);
    const body = await res.text();
    expect(supportReferenceOf(body)).toBe(header);
  });

  it("events-list guard 429 renders the passed id", async () => {
    const limited = await kitEventsGuard(
      new Request("https://example.test/events"),
      throttledEnv(),
      RAY,
    );
    expect(limited?.status).toBe(429);
    expect(supportReferenceOf(await limited!.text())).toBe(RAY);
  });

  it("guards ignore forged seed headers and hostile ids stay blank-safe", async () => {
    const forged = new Request("https://example.test/events/past", {
      headers: { [GUARD_REQUEST_ID_HEADER]: "01ARYZ6S41AAAAAAAAAAAAAAAA" },
    });
    const stripped = await kitPublicReadGuard(forged, throttledEnv());
    expect(stripped?.status).toBe(429);
    const strippedBody = await stripped!.text();
    expect(strippedBody).not.toContain("error-support-reference");
    expect(strippedBody).not.toContain("01ARYZ6S41AAAAAAAAAAAAAAAA");
    const hostile = await kitPublicReadGuard(
      new Request("https://example.test/events/past"),
      throttledEnv(),
      "<script>alert(1)</script>",
    );
    expect(hostile?.status).toBe(429);
    expect(await hostile!.text()).not.toContain("error-support-reference");
  });

  it("wrappers forward the dispatch id to the guard", async () => {
    const refusal = () => new Response("limited", { status: 429 });
    const pastGuard = vi.fn(async () => refusal());
    await dispatchPastArchiveRequest(
      new Request("https://example.test/events/past"),
      env,
      async () => new Response("must not resolve", { status: 500 }),
      pastGuard,
      Date.now(),
      RAY,
    );
    expect(pastGuard).toHaveBeenCalledWith(expect.any(Request), env, RAY);
    const hotGuard = vi.fn(async () => refusal());
    await dispatchHotzonesRequest(
      new Request("https://example.test/hotzones"),
      env,
      async () => new Response("must not resolve", { status: 500 }),
      hotGuard,
      RAY,
    );
    expect(hotGuard).toHaveBeenCalledWith(expect.any(Request), env, RAY);
    const eventsGuard = vi.fn(async () => refusal());
    await dispatchEventsRequest(
      new Request("https://example.test/events"),
      env,
      async () => {
        throw new Error("must not resolve");
      },
      { guard: eventsGuard, requestId: RAY },
    );
    expect(eventsGuard).toHaveBeenCalledWith(expect.any(Request), env, RAY);
    const detailGuard = vi.fn(async () => refusal());
    await dispatchEventDetailRequest(
      new Request("https://example.test/e/abc"),
      env,
      async () => new Response("must not resolve", { status: 500 }),
      detailGuard,
      RAY,
    );
    expect(detailGuard).toHaveBeenCalledWith(expect.any(Request), env, RAY);
  });

  it("hook passes its dispatch id to each guard wrapper", async () => {
    const cases: Array<{
      routeId: string;
      path: string;
      manifestPath: string;
      dep: "pastArchive" | "eventsPage" | "eventDetail" | "hotzones";
      reads: RouteReads;
    }> = [
      {
        routeId: "/events/past",
        path: "/events/past",
        manifestPath: "/events/past",
        dep: "pastArchive",
        reads: "public",
      },
      {
        routeId: "/events",
        path: "/events",
        manifestPath: "/events",
        dep: "eventsPage",
        reads: "public",
      },
      {
        routeId: "/hotzones",
        path: "/hotzones",
        manifestPath: "/hotzones",
        dep: "hotzones",
        reads: "public",
      },
      {
        routeId: "/e/[key]",
        path: "/e/abc",
        manifestPath: "/e/:key",
        dep: "eventDetail",
        reads: { resource: "member", action: "list", route: "events.page" },
      },
    ];
    for (const { routeId, path, manifestPath, dep, reads } of cases) {
      const request = new Request(new URL(path, APP_URL).href, {
        headers: { host: HOST, "cf-ray": RAY },
      });
      const wrapper = vi.fn(async () => new Response("limited", { status: 429 }));
      const deps: HookDispatchDeps = {
        appUrl: APP_URL,
        manifest: [{ method: "GET", path: manifestPath, enabled: true, reads }],
        honoFetch: async () => new Response("must not hono", { status: 500 }),
        resolve: async () => new Response("must not resolve", { status: 500 }),
      };
      deps[dep] = wrapper;
      const res = await dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: routeId } },
        deps,
      );
      expect(res.status).toBe(429);
      expect(wrapper).toHaveBeenCalledTimes(1);
      expect(wrapper).toHaveBeenCalledWith(expect.any(Request), expect.any(Function), RAY);
    }
  });
});
