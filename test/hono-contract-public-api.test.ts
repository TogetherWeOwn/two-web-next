// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// route-inventory: GET /openapi.json
// Mounted Hono characterization, not built-Worker or Kit parity. Existing
// api-public-* suites own payload/filter/failure/cache-lifecycle coverage.
// Only external read/admission edges are doubled; routing, middleware,
// serialization, validators and the isolate cache are the real app's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor } from "../src/admin/db";
import { readCounts } from "../src/counts";
import type { Env } from "../src/env";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../src/events/reads";
import { publicReadGuard } from "../src/events/routes-shared";
import app from "../src/index";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { validatePublicSchema } from "./helpers/public-api-schema";

vi.mock("../src/admin/db", () => ({ dbFor: vi.fn() }));
vi.mock("../src/counts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/counts")>()),
  readCounts: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  listPublicApiEvents: vi.fn(),
  getPublicApiEvent: vi.fn(),
}));
vi.mock("../src/events/routes-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/routes-shared")>()),
  publicReadGuard: vi.fn(),
}));

const ORIGIN = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DETAIL = `/api/public/events/${KEY}`;
const API_PATHS = ["/api/public/events", DETAIL, "/api/public/community", "/api/public/join"];
const PATHS = [...API_PATHS, "/openapi.json"];
const env = {
  APP_URL: ORIGIN,
  DISCORD_INVITE_URL: "https://discord.gg/test-invite",
} as Env;
const row: PublicApiEvent = {
  id: 1,
  eventKey: KEY,
  title: "Fixture night",
  game: null,
  description: null,
  accessibilityNotes: null,
  startsAt: new Date("2099-11-04T20:00:00Z"),
  endsAt: new Date("2099-11-04T22:00:00Z"),
  timezone: "UTC",
  location: null,
  organizer_name: null,
  join_url: null,
  join_instructions: null,
  capacity: null,
  status: "published",
  discordEventId: null,
  syncRevision: 1,
  syncedRevision: 0,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date("2099-01-01T00:00:00Z"),
  updatedAt: new Date("2099-01-01T00:00:00Z"),
  icsSequence: 0n,
  goingCount: 2,
  goingOccupancy: 3,
};

function request(path: string, method = "GET", headers: HeadersInit = {}, bindings = env) {
  return app.request(`${ORIGIN}${path}`, { method, headers }, bindings);
}

function noReads() {
  expect(dbFor).not.toHaveBeenCalled();
  expect(listPublicApiEvents).not.toHaveBeenCalled();
  expect(getPublicApiEvent).not.toHaveBeenCalled();
  expect(readCounts).not.toHaveBeenCalled();
}

function noCorsOrCookie(res: Response) {
  expect([...res.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual([]);
  expect(res.headers.has("set-cookie")).toBe(false);
}

async function expectFallbackBody(res: Response, path: string, method: string) {
  const html = path === "/openapi.json";
  expect(res.headers.get("content-type")).toContain(html ? "text/html" : "application/json");
  expect(res.headers.get("x-request-id")).toBeTruthy();
  expect(res.headers.has("etag")).toBe(false);
  if (method === "HEAD") expect(await res.text()).toBe("");
  else if (html) expect(await res.text()).toContain("We cannot find that page");
  else {
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "not_found",
        message: "No such API path.",
        request_id: res.headers.get("x-request-id"),
        next: "Check the API path and retry.",
      },
    });
    expect(validatePublicSchema(body, "PublicDataError")).toEqual([]);
  }
}

function denyAdmission() {
  vi.mocked(publicReadGuard).mockImplementation(
    async () => new Response("limited", { status: 429, headers: { "retry-after": "42" } }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetApiPublicCacheForTests();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
  vi.mocked(publicReadGuard).mockResolvedValue(null);
  vi.mocked(dbFor).mockResolvedValue({} as NonNullable<Awaited<ReturnType<typeof dbFor>>>);
  vi.mocked(listPublicApiEvents).mockResolvedValue({ rows: [row], total: 1, page: 1 });
  vi.mocked(getPublicApiEvent).mockResolvedValue(row);
  vi.mocked(readCounts).mockResolvedValue({
    memberCount: 12,
    onlineCount: 4,
    ranks: [{ key: "regular", label: "Regular", memberCount: 7 }],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden in public API characterization");
    }),
  );
});

afterEach(() => {
  __resetApiPublicCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mounted public API: methods and conditional HEAD", () => {
  it.each(PATHS)(
    "HEAD reaches the GET handler and shares its cached representation: %s",
    async (path) => {
      const head = await request(path, "HEAD");
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const reads = [dbFor, listPublicApiEvents, getPublicApiEvent, readCounts];
      const coldCalls = reads.map((read) => vi.mocked(read).mock.calls.length);
      if (path === "/api/public/events" || path === DETAIL) {
        expect(dbFor).toHaveBeenCalledOnce();
        const reader = path === DETAIL ? getPublicApiEvent : listPublicApiEvents;
        expect(reader).toHaveBeenCalledOnce();
        expect(vi.mocked(publicReadGuard).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(dbFor).mock.invocationCallOrder[0]!,
        );
      } else if (path === "/api/public/community") {
        expect(readCounts).toHaveBeenCalledExactlyOnceWith(env);
        expect(vi.mocked(publicReadGuard).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(readCounts).mock.invocationCallOrder[0]!,
        );
      } else {
        noReads();
      }
      const get = await request(path);
      expect(get.status).toBe(200);
      for (const name of [
        "content-type",
        "cache-control",
        "etag",
        "content-security-policy",
        "vary",
      ]) {
        expect(head.headers.get(name), name).toBe(get.headers.get(name));
      }
      expect(head.headers.get("etag")).toMatch(/^"[^"]+"$/);
      expect(head.headers.get("cache-control")).toBe(
        path === "/openapi.json" ? "public, max-age=3600" : "public, max-age=60",
      );
      expect(get.headers.has("vary")).toBe(false);
      const body = await get.json();
      if (path === "/api/public/community") {
        expect(body).toEqual({
          member_count: 12,
          online_count: 4,
          ranks: [{ key: "regular", label: "Regular", member_count: 7 }],
        });
        expect(validatePublicSchema(body, "CommunitySnapshot")).toEqual([]);
      }
      for (const etag of [head.headers.get("etag")!, `W/${head.headers.get("etag")}`, "*"]) {
        const conditional = await request(path, "HEAD", { "if-none-match": etag });
        // Current Hono helper accepts weak and wildcard validators. This records
        // native behavior, not approval of a future renderer's validator policy.
        expect(conditional.status).toBe(304);
        expect(await conditional.text()).toBe("");
        expect(conditional.headers.get("etag")).toBe(head.headers.get("etag"));
        expect(conditional.headers.get("cache-control")).toBe(head.headers.get("cache-control"));
        expect(conditional.headers.get("content-security-policy")).toBe(
          head.headers.get("content-security-policy"),
        );
        expect(conditional.headers.get("x-request-id")).toBeTruthy();
        noCorsOrCookie(conditional);
      }
      expect(reads.map((read) => vi.mocked(read).mock.calls.length)).toEqual(coldCalls);
      if (path === "/openapi.json") expect(publicReadGuard).not.toHaveBeenCalled();
      else expect(publicReadGuard).toHaveBeenCalledTimes(5);
      noCorsOrCookie(head);
      noCorsOrCookie(get);
    },
  );

  it.each(PATHS)(
    "unsupported verbs reach the namespace fallback, not a public read: %s",
    async (path) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const res = await request(path, method, { origin: ORIGIN });
        expect(res.status, method).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store, private");
        expect(res.headers.has("allow")).toBe(false);
        expect(res.headers.has("location")).toBe(false);
        await expectFallbackBody(res, path, method);
        noCorsOrCookie(res);
      }
      expect(publicReadGuard).not.toHaveBeenCalled();
      noReads();
    },
  );

  it.each(PATHS)("an untrusted unsafe verb stops at same-origin middleware: %s", async (path) => {
    const res = await request(path, "POST", { origin: "https://foreign.example.test" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "cross_origin",
      request_id: res.headers.get("x-request-id"),
    });
    expect(publicReadGuard).not.toHaveBeenCalled();
    noReads();
  });
});

describe("mounted public API: admission precedes cache and validation", () => {
  it.each(API_PATHS)("denies GET and HEAD before a warm representation: %s", async (path) => {
    expect((await request(path)).status).toBe(200);
    vi.clearAllMocks();
    denyAdmission();
    for (const method of ["GET", "HEAD"]) {
      const res = await request(path, method);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("42");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.has("etag")).toBe(false);
      if (method === "HEAD") expect(await res.text()).toBe("");
      else {
        const body = await res.json();
        expect(body).toMatchObject({ error: { request_id: res.headers.get("x-request-id") } });
        expect(validatePublicSchema(body, "PublicDataError")).toEqual([]);
      }
      noCorsOrCookie(res);
    }
    expect(publicReadGuard).toHaveBeenCalledTimes(2);
    noReads();
  });

  it.each(["/api/public/events/not-a-key", "/api/public/events?game="])(
    "denies before input validation: %s",
    async (path) => {
      denyAdmission();
      for (const method of ["GET", "HEAD"]) {
        const res = await request(path, method);
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("42");
      }
      expect(publicReadGuard).toHaveBeenCalledTimes(2);
      noReads();
    },
  );
});

describe("mounted public API: literal paths and decoded event keys", () => {
  it.each(PATHS)("does not redirect or admit a trailing slash: %s/", async (path) => {
    for (const method of ["GET", "HEAD"]) {
      const res = await request(`${path}/`, method);
      expect(res.status).toBe(404);
      expect(res.headers.has("location")).toBe(false);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      await expectFallbackBody(res, path, method);
      noCorsOrCookie(res);
    }
    expect(publicReadGuard).not.toHaveBeenCalled();
    noReads();
  });

  it("decodes an encoded ULID segment before the detail reader, without a redirect", async () => {
    const res = await request(`/api/public/events/%30${KEY.slice(1)}`);
    expect(res.status).toBe(200);
    expect(res.headers.has("location")).toBe(false);
    expect(getPublicApiEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), KEY);
    expect(await res.json()).toMatchObject({ event_key: KEY });
  });

  it.each([KEY.toLowerCase(), "%2F", "%ZZ", "%E0%A4%A"])(
    "refuses a decoded invalid key without reflecting it: %s",
    async (key) => {
      const res = await request(`/api/public/events/${key}`);
      expect(res.status).toBe(422);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: "invalid_request",
          message: "That event key is not valid.",
          request_id: res.headers.get("x-request-id"),
          next: "Fix the request and retry.",
        },
      });
      expect(validatePublicSchema(body, "PublicDataError")).toEqual([]);
      expect(publicReadGuard).toHaveBeenCalledOnce();
      noReads();
    },
  );

  it("keeps a missing detail uncacheable on GET and bodyless on HEAD", async () => {
    vi.mocked(getPublicApiEvent).mockResolvedValue(null);
    for (const method of ["GET", "HEAD"]) {
      const res = await request(DETAIL, method);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.has("etag")).toBe(false);
      if (method === "HEAD") expect(await res.text()).toBe("");
      else {
        const body = await res.json();
        expect(body).toMatchObject({ error: { code: "not_found" } });
        expect(validatePublicSchema(body, "PublicDataError")).toEqual([]);
      }
    }
    expect(getPublicApiEvent).toHaveBeenCalledTimes(2);
  });

  it("retains staging robots and security headers on OpenAPI HEAD/304 without admission", async () => {
    const staging = { ...env, APP_URL: "https://staging.example.test", APP_ENV: "staging" };
    const get = await app.request(`${staging.APP_URL}/openapi.json`, {}, staging);
    const head = await app.request(
      `${staging.APP_URL}/openapi.json`,
      {
        method: "HEAD",
        headers: { "if-none-match": get.headers.get("etag")! },
      },
      staging,
    );
    expect(get.status).toBe(200);
    expect(head.status).toBe(304);
    expect(head.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(head.headers.get("content-security-policy")).toBe(
      get.headers.get("content-security-policy"),
    );
    expect(await head.text()).toBe("");
    expect(publicReadGuard).not.toHaveBeenCalled();
    noReads();
  });
});
