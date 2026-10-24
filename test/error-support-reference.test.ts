// Browser 500/503 pages show the same support reference as x-request-id.
// Hermetic: local fixtures only, no database, no network. The reference is the
// already-validated request ID from requestLog, never raw client header bytes.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceHandler, registerErrorHandlers } from "../src/errors";
import type { Env } from "../src/env";
import { requestLog } from "../src/request-log";

const INVITE = "https://discord.gg/invite";
const env = { APP_URL: "https://example.test", DISCORD_INVITE_URL: INVITE } as Env;
const RAY = "0123456789abcdef-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SECRETS = [
  "cookie-secret",
  "bearer-secret",
  "query-secret",
  "198.51.100.42",
  "123456789012345678",
  "private fixture details",
  "private connection details",
];

const outage = () =>
  new Error("Failed query", {
    cause: Object.assign(new Error("private connection details"), { code: "ECONNREFUSED" }),
  });

function fixture() {
  const router = new Hono<{ Bindings: Env }>();
  router.use("*", requestLog);
  registerErrorHandlers(router);
  router.get("/500", () => {
    throw new Error(SECRETS.join(" "));
  });
  router.get("/503-db", () => {
    throw outage();
  });
  router.get("/503-maintenance", maintenanceHandler(INVITE));
  return router;
}

function withoutRequestLog() {
  const router = new Hono<{ Bindings: Env }>();
  registerErrorHandlers(router);
  router.get("/500", () => {
    throw new Error("private fixture details");
  });
  router.get("/503-db", () => {
    throw outage();
  });
  return router;
}

function reference(html: string): string | null {
  return html.match(/data-testid="error-support-reference">([^<]*)<\/code>/)?.[1] ?? null;
}

function assertNoLeak(html: string) {
  for (const secret of SECRETS) expect(html).not.toContain(secret);
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

describe("500 page support reference", () => {
  it("shows the admitted Ray ID exactly as x-request-id", async () => {
    const res = await fixture().request("/500?q=query-secret", { headers: { "cf-ray": RAY } }, env);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(reference(html)).toBe(RAY);
    assertNoLeak(html);
  });

  it("shows a generated ULID that matches x-request-id when no Ray ID is sent", async () => {
    const res = await fixture().request("/500", {}, env);
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(ULID);
    expect(reference(await res.text())).toBe(id);
  });

  it.each([
    "cookie-secret",
    "0123456789abcdef-IP-secret",
    "123456789012345678",
    '0123456789abcdef-LHR"><b>x</b>',
  ])("replaces hostile cf-ray %s with the generated reference", async (ray) => {
    const res = await fixture().request("/500", { headers: { "cf-ray": ray } }, env);
    const html = await res.text();
    const id = res.headers.get("x-request-id");
    expect(id).not.toBe(ray);
    expect(id).toMatch(ULID);
    expect(reference(html)).toBe(id);
    expect(html).not.toContain(ray);
  });
});

describe("503 page support reference", () => {
  it("shows the Ray ID on a database outage page", async () => {
    const res = await fixture().request("/503-db", { headers: { "cf-ray": RAY } }, env);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(reference(html)).toBe(RAY);
    expect(html).toContain('data-testid="error-invite"');
    assertNoLeak(html);
  });

  it("shows the Ray ID on the maintenance handler's 503 page", async () => {
    const res = await fixture().request("/503-maintenance", { headers: { "cf-ray": RAY } }, env);
    expect(res.status).toBe(503);
    expect(reference(await res.text())).toBe(RAY);
  });

  it("includes the validated request_id in the JSON 503 envelope", async () => {
    const res = await fixture().request(
      "/503-db",
      { headers: { "cf-ray": RAY, accept: "application/json" } },
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "db_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
      request_id: RAY,
    });
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });
});

describe("missing request ID", () => {
  it.each(["/500", "/503-db"])(
    "omits the reference rather than printing a placeholder on %s",
    async (path) => {
      const res = await withoutRequestLog().request(path, {}, env);
      const html = await res.text();
      expect(html).not.toContain('data-testid="error-support-reference"');
      expect(html).not.toContain("undefined");
      expect(html).toContain('data-testid="error-invite"');
      expect(res.headers.get("x-request-id")).toBeNull();
    },
  );
});
