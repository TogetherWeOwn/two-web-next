// Acceptance: the 429 page shows the same support reference the 500/503
// pages show, and the shared 429/503 JSON envelopes carry the validated
// request_id. The reference is always the requestLog-validated ID behind
// x-request-id (an admitted Ray ID or a generated ULID); a client-supplied
// x-request-id header is input, never the reference. Scope is the shared
// helpers (rateLimitExceeded / databaseUnavailable) reached through the
// throttle middleware and the registered error handlers. Hermetic: local
// fixtures only, no database, no network.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { databaseUnavailable, rateLimitExceeded, registerErrorHandlers } from "../src/errors";
import { requestLog } from "../src/request-log";
import { throttle, type EnvWithThrottle } from "../src/throttle";

const INVITE = "https://discord.gg/invite";
const env = { APP_URL: "https://example.test", DISCORD_INVITE_URL: INVITE } as Env;
const RAY = "0123456789abcdef-LHR";
const CLIENT_RAY = "fedcba9876543210-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SECRETS = [
  "cookie-secret",
  "bearer-secret",
  "query-secret",
  "198.51.100.42",
  "123456789012345678",
  "private connection details",
];
const SECRET_HEADERS = {
  cookie: "session=cookie-secret",
  authorization: "Bearer bearer-secret",
  "cf-connecting-ip": "198.51.100.42",
};
const SECRET_QUERY = "?q=query-secret&member=123456789012345678";

const outage = () =>
  new Error("Failed query", {
    cause: Object.assign(new Error("private connection details"), { code: "ECONNREFUSED" }),
  });

function fakeStore() {
  const hits: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SELECT count(*)")) {
      const rows = hits.filter((h) => h.bucket === v[0] && h.at > Date.now() - 60_000);
      return [{ n: rows.length, wait: 30 }];
    }
    if (head.includes("INSERT INTO web_throttle_hits"))
      hits.push({ bucket: v[0] as string, at: Date.now() });
    return [];
  }) as unknown as never;
  (
    sql as unknown as { begin: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  ).begin = (run) => run(sql);
  // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before the
  // advisory lock (as in test/join.test.ts); the double passes it through.
  (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, hits };
}

/** One allowed POST, then the throttled one with the caller's headers. */
async function throttled(headers: Record<string, string>, withLog = true): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  if (withLog) app.use("*", requestLog);
  app.post("/x", throttle("t", 1), (c) => c.body(null, 204));
  const { sql } = fakeStore();
  const bindings = { ...env, THROTTLE_STORE: async () => sql } as unknown as EnvWithThrottle;
  // Same headers on both requests: the client key (and so the bucket) is
  // derived from them, so the warm-up hit must land in the same bucket.
  expect((await app.request("/x", { method: "POST", headers }, bindings)).status).toBe(204);
  return app.request(`/x${SECRET_QUERY}`, { method: "POST", headers }, bindings);
}

function outageApp(withLog = true) {
  const router = new Hono<{ Bindings: Env }>();
  if (withLog) router.use("*", requestLog);
  registerErrorHandlers(router);
  router.get("/503-db", () => {
    throw outage();
  });
  return router;
}

function directApp(withLog = true) {
  const router = new Hono<{ Bindings: Env }>();
  if (withLog) router.use("*", requestLog);
  router.post("/limited", (c) => rateLimitExceeded(c, 30));
  router.post("/events/:key/publish", (c) => rateLimitExceeded(c, 30));
  router.get("/unavailable", (c) => databaseUnavailable(c, true));
  return router;
}

function reference(html: string): string | null {
  return html.match(/data-testid="error-support-reference">([^<]*)<\/code>/)?.[1] ?? null;
}

function assertNoLeak(body: string) {
  for (const secret of SECRETS) expect(body).not.toContain(secret);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("support reference fixtures must remain offline");
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("429 HTML page support reference", () => {
  it("shows the admitted Ray ID exactly as x-request-id, with Retry-After unchanged", async () => {
    const res = await throttled({ ...SECRET_HEADERS, "cf-ray": RAY, accept: "text/html" });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const html = await res.text();
    expect(html).toContain("Support reference");
    expect(reference(html)).toBe(RAY);
    expect(html).toContain('data-testid="error-invite"');
    assertNoLeak(html);
  });

  it("shows a generated ULID that matches x-request-id when no Ray ID is sent", async () => {
    const res = await throttled({ accept: "text/html" });
    expect(res.status).toBe(429);
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(ULID);
    expect(reference(await res.text())).toBe(id);
  });

  it("ignores a client-supplied x-request-id, even one shaped like a Ray ID", async () => {
    const res = await throttled({ accept: "text/html", "x-request-id": CLIENT_RAY });
    const html = await res.text();
    const id = res.headers.get("x-request-id");
    expect(id).not.toBe(CLIENT_RAY);
    expect(id).toMatch(ULID);
    expect(reference(html)).toBe(id);
    expect(html).not.toContain(CLIENT_RAY);
  });

  it("prefers the admitted Ray ID over a client-supplied x-request-id", async () => {
    const res = await throttled({
      accept: "text/html",
      "cf-ray": RAY,
      "x-request-id": CLIENT_RAY,
    });
    const html = await res.text();
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(reference(html)).toBe(RAY);
    expect(html).not.toContain(CLIENT_RAY);
  });

  it.each([
    "cookie-secret",
    "0123456789abcdef-IP-secret",
    "123456789012345678",
    '0123456789abcdef-LHR"><b>x</b>',
  ])("replaces hostile cf-ray %s with the generated reference", async (ray) => {
    const res = await throttled({ accept: "text/html", "cf-ray": ray });
    const html = await res.text();
    const id = res.headers.get("x-request-id");
    expect(id).not.toBe(ray);
    expect(id).toMatch(ULID);
    expect(reference(html)).toBe(id);
    expect(html).not.toContain(ray);
  });

  it("keeps the HTML page when JSON is refused with q=0, reference included", async () => {
    const res = await throttled({
      "cf-ray": RAY,
      accept: "text/html, application/json;q=0",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(reference(await res.text())).toBe(RAY);
  });
});

describe("429 JSON envelope request_id", () => {
  it("carries the admitted Ray ID as request_id, shape otherwise unchanged", async () => {
    const res = await throttled({ ...SECRET_HEADERS, "cf-ray": RAY, accept: "application/json" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      reason: "rate_limited",
      message: "Too many requests. Try again in 30 seconds.",
      retry_after: 30,
      request_id: RAY,
    });
    assertNoLeak(body);
  });

  it("carries the generated ULID that matches x-request-id when no Ray ID is sent", async () => {
    const res = await throttled({ accept: "application/json" });
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(ULID);
    expect(await res.json()).toMatchObject({ reason: "rate_limited", request_id: id });
  });

  it("never echoes a client-supplied x-request-id in the envelope", async () => {
    const res = await throttled({ accept: "application/json", "x-request-id": CLIENT_RAY });
    const body = await res.text();
    const parsed = JSON.parse(body) as { request_id?: unknown };
    expect(parsed.request_id).toBe(res.headers.get("x-request-id"));
    expect(parsed.request_id).not.toBe(CLIENT_RAY);
    expect(body).not.toContain(CLIENT_RAY);
  });

  it("replaces a hostile cf-ray with the generated ULID in the envelope", async () => {
    const hostile = '0123456789abcdef-LHR"><b>x</b>';
    const res = await throttled({ accept: "application/json", "cf-ray": hostile });
    const body = await res.text();
    const parsed = JSON.parse(body) as { request_id?: unknown };
    expect(parsed.request_id).toMatch(ULID);
    expect(parsed.request_id).toBe(res.headers.get("x-request-id"));
    expect(body).not.toContain(hostile);
  });

  it("keeps JSON-only event writes on the JSON envelope, request_id included", async () => {
    const res = await directApp().request(
      "/events/abc/publish",
      { method: "POST", headers: { "cf-ray": RAY, accept: "text/html" } },
      env,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(await res.json()).toMatchObject({ reason: "rate_limited", request_id: RAY });
  });
});

describe("503 JSON envelope request_id", () => {
  it("carries the admitted Ray ID as request_id, shape otherwise unchanged", async () => {
    const res = await outageApp().request(
      `/503-db${SECRET_QUERY}`,
      { headers: { ...SECRET_HEADERS, "cf-ray": RAY, accept: "application/json" } },
      env,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      error: "db_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
      request_id: RAY,
    });
    assertNoLeak(body);
  });

  it("carries the generated ULID that matches x-request-id when no Ray ID is sent", async () => {
    const res = await outageApp().request(
      "/503-db",
      { headers: { accept: "application/json" } },
      env,
    );
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(ULID);
    expect(await res.json()).toMatchObject({ error: "db_unavailable", request_id: id });
  });

  it("never echoes a client-supplied x-request-id in the envelope", async () => {
    const res = await outageApp().request(
      "/503-db",
      { headers: { accept: "application/json", "x-request-id": CLIENT_RAY } },
      env,
    );
    const body = await res.text();
    const parsed = JSON.parse(body) as { request_id?: unknown };
    expect(parsed.request_id).toBe(res.headers.get("x-request-id"));
    expect(parsed.request_id).not.toBe(CLIENT_RAY);
    expect(body).not.toContain(CLIENT_RAY);
  });

  it("replaces a hostile cf-ray with the generated ULID in the envelope", async () => {
    const hostile = "123456789012345678";
    const res = await outageApp().request(
      "/503-db",
      { headers: { accept: "application/json", "cf-ray": hostile } },
      env,
    );
    const body = await res.text();
    const parsed = JSON.parse(body) as { request_id?: unknown };
    expect(parsed.request_id).toMatch(ULID);
    expect(parsed.request_id).toBe(res.headers.get("x-request-id"));
    expect(body).not.toContain(hostile);
  });

  it("keeps explicit JSON-only 503 endpoints on the JSON envelope, request_id included", async () => {
    const res = await directApp().request(
      "/unavailable",
      { headers: { "cf-ray": RAY, accept: "text/html" } },
      env,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: "db_unavailable", request_id: RAY });
  });

  it("control: the 503 HTML page already shows the same reference", async () => {
    const res = await outageApp().request(
      "/503-db",
      { headers: { "cf-ray": RAY, accept: "text/html" } },
      env,
    );
    expect(res.status).toBe(503);
    expect(reference(await res.text())).toBe(RAY);
  });
});

describe("missing request ID (no requestLog)", () => {
  it("control: omits the reference on the 429 page rather than printing a placeholder", async () => {
    const res = await throttled({ accept: "text/html" }, false);
    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).not.toContain('data-testid="error-support-reference"');
    expect(html).not.toContain("undefined");
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("control: fabricates no request_id in the 429 JSON envelope", async () => {
    const res = await throttled({ accept: "application/json" }, false);
    const body = await res.text();
    const parsed = JSON.parse(body) as { request_id?: unknown };
    expect(parsed).toMatchObject({ reason: "rate_limited", retry_after: 30 });
    expect(parsed.request_id ?? null).toBeNull();
    expect(body).not.toContain("undefined");
  });

  it("control: fabricates no request_id in the 503 JSON envelope", async () => {
    const res = await outageApp(false).request(
      "/503-db",
      { headers: { accept: "application/json" } },
      env,
    );
    const body = await res.text();
    const parsed = JSON.parse(body) as { request_id?: unknown };
    expect(parsed).toMatchObject({ error: "db_unavailable" });
    expect(parsed.request_id ?? null).toBeNull();
    expect(body).not.toContain("undefined");
    expect(res.headers.get("x-request-id")).toBeNull();
  });
});

describe("negotiation controls (unchanged behavior)", () => {
  it("serves the HTML page by default when no Accept header is sent", async () => {
    const res = await throttled({});
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves the JSON envelope when JSON is preferred over HTML", async () => {
    const res = await throttled({ accept: "text/html;q=0.1, application/json;q=1" });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("vary")).toContain("Accept");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
