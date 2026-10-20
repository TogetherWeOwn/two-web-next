// route-inventory: GET /events.json
// route-inventory: GET /events/:key
// Event JSON negotiation: pins the unauthenticated Accept branches of
// `jsonSession` (src/events/routes-shared.ts) through the mounted app. An
// explicit `text/html` range with no JSON range 302-redirects a cookieless
// visitor to login; everything else — including a mixed `text/html,
// application/json` Accept and a q=0-excluded `text/html` — 401s JSON.
// Hermetic and DB-free: the negotiation answers before any event or session
// read, so no DATABASE_URL, no Discord, no database. A swapped-branch
// negative control (expect 302 on the mixed Accept) must fail here.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";

// Canonical uppercase ULID shape: the detail route's canonical-301 check
// passes it through to the session gate instead of redirecting first.
const KEY = "01J00000000000000000000002";
const COLLECTION = "/events.json";
const DETAIL = `/events/${KEY}`;

const loginFor = (path: string) => `/join/discord?next=${encodeURIComponent(path)}`;

/** Fresh memory store per request: unauthenticated reads must never reach it. */
function env(): Env {
  return {
    APP_URL: "https://next.example.test",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

async function get(path: string, accept: string): Promise<Response> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the negotiation paths");
    }),
  );
  return app.request(path, { headers: { accept } }, env());
}

function expectNegotiationHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("vary")).toBe("Cookie, Accept");
}

describe("event JSON negotiation (DB-free)", () => {
  it("302s a cookieless text/html visitor on the collection route to login", async () => {
    const res = await get(COLLECTION, "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(loginFor(COLLECTION));
    expectNegotiationHeaders(res);
  });

  it("302s a cookieless text/html visitor on the detail route to login", async () => {
    const res = await get(DETAIL, "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(loginFor(DETAIL));
    expectNegotiationHeaders(res);
  });

  it("keeps the collection query string in the login return target", async () => {
    const path = `${COLLECTION}?page=2`;
    const res = await get(path, "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(loginFor(path));
    expectNegotiationHeaders(res);
  });

  it("stays 401 JSON on the collection route for a mixed html+json Accept", async () => {
    const res = await get(COLLECTION, "text/html, application/json");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expectNegotiationHeaders(res);
  });

  it("stays 401 JSON on the detail route for a mixed html+json Accept", async () => {
    const res = await get(DETAIL, "text/html, application/json");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expectNegotiationHeaders(res);
  });

  it("stays 401 JSON on the collection route when text/html is q=0-excluded", async () => {
    const res = await get(COLLECTION, "text/html; q=0");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expectNegotiationHeaders(res);
  });

  it("stays 401 JSON on the detail route when text/html is q=0-excluded", async () => {
    const res = await get(DETAIL, "text/html; q=0");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expectNegotiationHeaders(res);
  });
});
