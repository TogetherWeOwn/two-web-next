// Implementation-owned pins for Kit error request correlation. The
// failing-first acceptance suite (test/kit-error-request-correlation.test.ts,
// owned by the acceptance card) pins the shell markup, the boundary
// threading and the dispatch header contract; this file pins the links the
// Builder added around it: the Kit same-origin refusal carries an id, the
// member-read boundary alerts with the served id, the load helpers forward
// the binding's id to their error.alert lines, and the Hono-fallback return
// keeps Hono's own header untouched. Hermetic: local fixtures only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { loadActivityLogPage } from "../src/admin/kit-activity-log";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { loadHotzonesIndexData } from "../src/kit-hotzones";
import { loadMembersBoardData } from "../src/kit-members";
import { safeRequestId } from "../src/request-log";
import { dispatchHookRequest, type HookEventLike } from "../src/route-ownership";

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
