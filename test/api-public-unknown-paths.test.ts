// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import type { EnvWithThrottle } from "../src/throttle";
import { validatePublicSchema } from "./helpers/public-api-schema";
import { QUERY_CANARY, UNKNOWN_PATHS } from "./helpers/public-unknown-paths";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/test-invite-handoff";
const ASSET_CANARY = "ASSET-BYTES-SHOULD-NOT-LEAK";

// Every entry must stay an unknown path inside /api/public after WHATWG URL
// normalization: bare `%2e%2e` segments resolve away before the app sees
// them, and known routes keep their own status (see the controls below).
const HOSTILE_PATHS = [
  "/api/public/%2e%2e%2f%2e%2e%2fetc/passwd",
  "/api/public/..%2f..%2fetc/passwd",
  "/api/public/%3Cscript%3Ealert(1)%3C/script%3E",
  "/api/public/unknown?probe=%3Cscript%3E",
  "/api/public/unknown/%00",
  "/api/public/unknown?x=../etc/passwd",
] as const;

const baseEnv = {
  APP_URL,
  DISCORD_INVITE_URL: INVITE_URL,
  DISCORD_BOT_TOKEN: "bot-token-canary-never-served",
  THROTTLE_STORE: async () => null,
} as unknown as Env & EnvWithThrottle;

const assetEnv = (_body: BodyInit | null, _init: ResponseInit, fetch: ReturnType<typeof vi.fn>) =>
  ({ ...baseEnv, ASSETS: { fetch } }) as unknown as Env & EnvWithThrottle;

type PublicErrorBody = {
  error: { code: string; message: string; request_id: string; next: string };
};

async function expectUnknownJson(res: Response, path: string): Promise<PublicErrorBody> {
  expect(res.status, path).toBe(404);
  expect(res.headers.get("content-type"), path).toContain("application/json");
  expect(res.headers.get("cache-control"), path).toBe("no-store, private");
  expect(res.headers.get("set-cookie"), path).toBeNull();
  const headerId = res.headers.get("x-request-id");
  expect(headerId, `${path} x-request-id`).toBeTruthy();
  const raw = await res.text();
  expect(raw, `${path} no branded HTML`).not.toMatch(/<!doctype|<html|error-heading/i);
  expect(raw, `${path} no asset bytes`).not.toContain(ASSET_CANARY);
  expect(raw, `${path} no reflected path`).not.toContain(encodeURIComponent(path));
  expect(raw, `${path} no plain reflected path`).not.toContain(path.split("?")[0]);
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  if (query) {
    // The query is caller input too: neither its raw nor encoded form echoes.
    expect(raw, `${path} no raw reflected query`).not.toContain(query);
    expect(raw, `${path} no encoded reflected query`).not.toContain(encodeURIComponent(query));
  }
  if (path.includes(QUERY_CANARY)) {
    expect(raw, `${path} no query canary`).not.toContain(QUERY_CANARY);
  }
  // The raw path must never echo: hostile bytes stay inert.
  for (const fragment of ["<script", "etc/passwd", "%2e", "%00", "%3C"]) {
    if (path.toLowerCase().includes(fragment.toLowerCase())) {
      expect(raw.toLowerCase(), `${path} inert ${fragment}`).not.toContain(fragment.toLowerCase());
    }
  }
  const body = JSON.parse(raw) as PublicErrorBody;
  expect(validatePublicSchema(body, "PublicDataError"), path).toEqual([]);
  expect(body.error.code, path).toBe("not_found");
  expect(body.error.next, path).toBe("Check the API path and retry.");
  expect(body.error.message, path).toBe("No such API path.");
  expect(body.error.request_id, path).toBe(headerId);
  return body;
}

// ---------------------------------------------------------------------------
// Offline: unknown paths return JSON, boundaries stay put. No DB needed.
// ---------------------------------------------------------------------------

describe("public API unknown paths return JSON (offline)", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
  });

  const get = (path: string, env: Env & EnvWithThrottle = baseEnv, ip = "192.0.2.91") =>
    app.request(path, { headers: { "cf-connecting-ip": ip } }, env);

  it.each([...UNKNOWN_PATHS])("GET %s answers the JSON not_found envelope", async (path) => {
    const body = await expectUnknownJson(await get(path), path);
    expect(body.error.code).toBe("not_found");
  });

  it.each([...UNKNOWN_PATHS])("GET %s ignores ASSETS and never looks an asset up", async (path) => {
    const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
    const res = await get(path, assetEnv(ASSET_CANARY, { status: 200 }, fetch));
    await expectUnknownJson(res, path);
    expect(fetch, path).not.toHaveBeenCalled();
  });

  it.each([...HOSTILE_PATHS])("GET %s stays an inert JSON 404", async (path) => {
    const res = await get(path);
    expect(res.status, path).not.toBe(500);
    await expectUnknownJson(res, path);
  });

  it.each([...HOSTILE_PATHS])("GET %s with ASSETS stays inert with no lookup", async (path) => {
    const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
    const res = await get(path, assetEnv(ASSET_CANARY, { status: 200 }, fetch));
    await expectUnknownJson(res, path);
    expect(fetch, path).not.toHaveBeenCalled();
  });

  it.each([...HOSTILE_PATHS])("%s stays an unknown in-namespace path once normalized", (path) => {
    // Guard on the fixture itself: a hostile entry that normalizes out of
    // the namespace or onto a known route cannot test the unknown handler.
    const { pathname } = new URL(path, APP_URL);
    expect(pathname, path).toMatch(/^\/api\/public\/./);
    expect(["/api/public/community", "/api/public/events", "/api/public/join"], path).not.toContain(
      pathname,
    );
    expect(pathname, path).not.toMatch(/^\/api\/public\/events\/[^/]+$/);
  });

  it("keeps the unknown message and next static across paths", async () => {
    const first = await expectUnknownJson(await get("/api/public/cache"), "/api/public/cache");
    const second = await expectUnknownJson(
      await get("/api/public/unknown/nested/deep"),
      "/api/public/unknown/nested/deep",
    );
    expect(second.error.message).toBe(first.error.message);
    expect(second.error.next).toBe(first.error.next);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s respects same-origin protection",
    async (method) => {
      const path = "/api/public/cache";
      const denied = await app.request(
        path,
        { method, headers: { origin: "https://evil.example" } },
        baseEnv,
      );
      expect(denied.status).toBe(403);
      const admitted = await app.request(path, { method, headers: { origin: APP_URL } }, baseEnv);
      await expectUnknownJson(admitted, path);
    },
  );

  it.each([...UNKNOWN_PATHS])("HEAD %s keeps status/headers with no body", async (path) => {
    const res = await app.request(
      path,
      { method: "HEAD", headers: { "cf-connecting-ip": "192.0.2.92" } },
      baseEnv,
    );
    expect(res.status, path).toBe(404);
    expect(res.headers.get("content-type"), path).toContain("application/json");
    expect(res.headers.get("cache-control"), path).toBe("no-store, private");
    expect(res.headers.get("x-request-id"), path).toBeTruthy();
    expect(res.headers.get("set-cookie"), path).toBeNull();
    expect(await res.text(), path).toBe("");
  });

  it.each([...UNKNOWN_PATHS])(
    "HEAD %s with ASSETS keeps headers, no body, no lookup",
    async (path) => {
      const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
      const res = await app.request(
        path,
        { method: "HEAD", headers: { "cf-connecting-ip": "192.0.2.93" } },
        assetEnv(ASSET_CANARY, { status: 200 }, fetch),
      );
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("application/json");
      expect(await res.text(), path).toBe("");
      expect(fetch, path).not.toHaveBeenCalled();
    },
  );

  it("answers unknown JSON without touching the database", async () => {
    // The getter is a spy, so a handler that reads ADMIN_DB and swallows the
    // error still fails the zero-read assertion.
    const adminDb = vi.fn((): never => {
      throw new Error("Unknown paths must not read the database");
    });
    const offline = {
      ...baseEnv,
      get ADMIN_DB(): never {
        return adminDb();
      },
    } as unknown as Env & EnvWithThrottle;
    const res = await app.request(
      "/api/public/unknown",
      { headers: { "cf-connecting-ip": "192.0.2.98" } },
      offline,
    );
    await expectUnknownJson(res, "/api/public/unknown");
    expect(adminDb).not.toHaveBeenCalled();
  });
});
