import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { registerErrorHandlers } from "../src/errors";
import type { Env } from "../src/env";
import { newRequestId, requestLog, safeRequestId } from "../src/request-log";

const env = { APP_URL: "https://example.test", SESSION_SECRET: "fixture-only" } as Env;
const RAY = "0123456789abcdef-LHR";
const PERSONAL = ["cookie-secret", "bearer-secret", "query-secret", "198.51.100.42", "123456789012345678"];
afterEach(() => vi.restoreAllMocks());

function logs(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)));
}

function fixture() {
  const router = new Hono<{ Bindings: Env }>();
  router.use("*", requestLog);
  registerErrorHandlers(router);
  router.get("/members/:user", (c) => c.text("ok"));
  router.get("/boom/:id", () => { throw new Error(PERSONAL.join(" ")); });
  router.get("/redirect", (c) => c.redirect("/members/123", 302));
  router.get("/denied", (c) => c.text("Forbidden", 403));
  router.get("/limited", (c) => c.json({ error: "throttled" }, 429));
  router.get("/cached", (c) => c.body(null, 304));
  router.use("/admin/*", async (c) => c.text("Forbidden", 403));
  const child = new Hono();
  child.get("/events/:id", (c) => c.text("event"));
  router.route("/admin", child);
  const publicChild = new Hono();
  publicChild.get("/items/:id", (c) => c.text("item"));
  router.route("/api", publicChild);
  return router;
}

describe("structured request logs (local fixtures only)", () => {
  it("emits exactly one allowlisted JSON line with a Ray ID and no request data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = new Request(`https://example.test/members/${PERSONAL[4]}?token=${PERSONAL[2]}`, {
      headers: { "cf-ray": RAY, "x-request-id": "client-controlled", cookie: PERSONAL[0]!, authorization: `Bearer ${PERSONAL[1]}`, "cf-connecting-ip": PERSONAL[3]! },
    });
    Object.defineProperty(req, "cf", { value: { colo: "LHR", city: "private-city" } });
    const res = await fixture().fetch(req, env);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(log).toHaveBeenCalledTimes(1);
    expect(logs(log)).toEqual([{
      event: "http.request", request_id: RAY, method: "GET", route: "/members/:user",
      status: 200, duration_ms: expect.any(Number), colo: "LHR",
    }]);
    expect(logs(log)[0].duration_ms).toBeGreaterThanOrEqual(0);
    for (const value of [...PERSONAL, "client-controlled", "private-city"]) expect(JSON.stringify(log.mock.calls)).not.toContain(value);
  });

  it.each([
    ["/redirect", 302, "/redirect"], ["/denied", 403, "/denied"], ["/limited", 429, "/limited"],
    ["/cached", 304, "/cached"], ["/missing/private-id?secret=secret", 404, "unmatched"],
    ["/api/items/private-id", 200, "/api/items/:id"], ["/admin/events/private-id", 403, "/admin/events/:id"],
  ])("logs final status and an ID for %s", async (path, status, route) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await fixture().request(path, {}, env);
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(logs(log)).toEqual([expect.objectContaining({ request_id: id, route, status, colo: null })]);
    expect(res.status).toBe(status);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-id");
  });

  it("correlates a handled 500 with its alert without logging the exception message", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fixture().request("/boom/private-id?token=query-secret", { headers: { "cf-ray": RAY } }, env);
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(logs(log)).toEqual([expect.objectContaining({ request_id: RAY, status: 500, route: "/boom/:id" })]);
    const alerts = error.mock.calls.filter(([line]) => typeof line === "string" && line.startsWith("{"));
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(String(alerts[0]![0]))).toMatchObject({ event: "error.alert", request_id: RAY, route: "/boom/:id" });
    for (const value of [...PERSONAL, "private-id"]) expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(value);
  });

  it("logs downstream response replacements, not the original 200", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const router = new Hono();
    router.use("*", requestLog);
    router.use("*", async (c, next) => { await next(); c.res = c.text("unavailable", 503); });
    router.get("/read", (c) => c.text("ok"));
    const res = await router.request("/read");
    expect(res.status).toBe(503);
    expect(logs(log)).toEqual([expect.objectContaining({ status: 503, request_id: res.headers.get("x-request-id") })]);
  });

  it.each(["cookie-secret", "123456789012345678", "0123456789abcdef-IP-secret"])("rejects forged cf-ray %s", async (ray) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await fixture().request("/denied", { headers: { "cf-ray": ray } }, env);
    expect(res.headers.get("x-request-id")).not.toBe(ray);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(ray);
  });

  it("adds the header to HEAD responses and only accepts a colo code", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = new Request("https://example.test/members/private-id", { method: "HEAD", headers: { "cf-ray": RAY } });
    Object.defineProperty(req, "cf", { value: { colo: "198.51.100.42" } });
    const res = await fixture().fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    expect(logs(log)).toEqual([expect.objectContaining({ method: "HEAD", route: "/members/:user", colo: null })]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("198.51.100.42");
  });

  it("generates unique ULIDs with the timestamp encoded in the first ten characters", () => {
    vi.spyOn(Date, "now").mockReturnValue(1469918176385);
    const ids = Array.from({ length: 100 }, () => newRequestId());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      expect(id.slice(0, 10)).toBe("01ARYZ6S41");
      expect(safeRequestId(id)).toBe(id);
    }
    expect(safeRequestId("8" + ids[0]!.slice(1))).toBeUndefined();
  });

  it("is mounted on the real app including errors, redirects and guarded sub-apps", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [path, status, route] of [
      ["/up", 503, "/up"], ["/discord", 302, "/discord"],
      ["/members/123456789012345678", 302, "/members/:user"],
      ["/admin/events/123456789012345678", 302, "/admin/events/:key"],
      ["/no-such-path/123456789012345678", 404, "unmatched"],
    ] as const) {
      log.mockClear();
      const res = await app.request(path, { headers: { "cf-ray": RAY } }, env as never);
      expect(res.status).toBe(status);
      expect(res.headers.get("x-request-id")).toBe(RAY);
      expect(logs(log)).toEqual([expect.objectContaining({ route, status, request_id: RAY })]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("123456789012345678");
    }
  });
});
