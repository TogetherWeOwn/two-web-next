// N5 (TOG-9897): human-route throttles + the every-POST-throttled audit
// (ports TOG-8709: a new mutating route that ships without a throttle fails CI).
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import { isThrottleMiddleware, throttle, type EnvWithThrottle } from "../src/throttle";
import { Hono } from "hono";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Mutating routes that are deliberately not on the shared middleware, each with
// the reason its own limiter stands in. Adding an entry needs a reviewer's nod.
const EXEMPT: Record<string, string> = {
  "POST /csp-reports": "database-free funnel sink; flood control in the handler (204 during a DB outage)",
  "POST /api/agent-events": "agent ingress; its own HMAC-signed limiter, same 429 envelope (W14)",
  "PUT /events/:key/rsvp": "shared 12/min transactional RSVP budget (W9)",
  "DELETE /events/:key/rsvp": "shared 12/min transactional RSVP budget (W9)",
  "PATCH /members/:user": "in-handler 30/min profile-write bucket (W7)",
  "POST /members/:user": "in-handler 30/min profile-write bucket (W7)",
};

describe("every mutating route is throttled", () => {
  const routes = app.routes.filter((r) => MUTATING.has(r.method));
  const keys = new Map<string, boolean>();
  for (const r of routes) {
    const k = `${r.method} ${r.path}`;
    keys.set(k, (keys.get(k) ?? false) || isThrottleMiddleware(r.handler));
  }

  it("finds mutating routes at all", () => expect(keys.size).toBeGreaterThan(10));

  it("has no unthrottled mutating route outside the exemption list", () => {
    const bare = [...keys].filter(([k, t]) => !t && !(k in EXEMPT)).map(([k]) => k);
    expect(bare).toEqual([]);
  });

  it("registers throttled pause/reopen actions in both route families", () => {
    for (const prefix of ["/events", "/admin/events"]) {
      for (const action of ["rsvp-pause", "rsvp-reopen"]) {
        expect(keys.get(`POST ${prefix}/:key/${action}`)).toBe(true);
      }
    }
  });

  it("keeps the exemption list honest (every entry is a real route)", () => {
    for (const k of Object.keys(EXEMPT)) expect(keys.has(k), k).toBe(true);
  });
});

function fakeStore() {
  const hits: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const head = strings.join("?");
    if (head.includes("SELECT count(*)")) {
      const rows = hits.filter((h) => h.bucket === v[0] && h.at > Date.now() - 60_000);
      return [{ n: rows.length, wait: 30 }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) hits.push({ bucket: v[0] as string, at: Date.now() });
    return [];
  }) as unknown as never;
  return { sql, hits };
}

describe("throttle middleware", () => {
  const mk = (max: number) => {
    const a = new Hono<{ Bindings: Env }>();
    a.post("/x", throttle("t", max), (c) => c.body(null, 204));
    const { sql } = fakeStore();
    const e = { THROTTLE_STORE: async () => sql } as unknown as EnvWithThrottle;
    return { a, e };
  };

  it("allows the budget then refuses with the one JSON 429 envelope", async () => {
    const { a, e } = mk(3);
    for (let i = 0; i < 3; i++) expect((await a.request("/x", { method: "POST" }, e)).status).toBe(204);
    const res = await a.request("/x", { method: "POST", headers: { accept: "application/json" } }, e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
  });

  it("renders the branded page for browsers", async () => {
    const { a, e } = mk(1);
    await a.request("/x", { method: "POST" }, e);
    const res = await a.request("/x", { method: "POST", headers: { accept: "text/html" } }, e);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("allows when no store is configured", async () => {
    const a = new Hono<{ Bindings: Env }>();
    a.post("/x", throttle("t", 1), (c) => c.body(null, 204));
    for (let i = 0; i < 3; i++) expect((await a.request("/x", { method: "POST" }, {} as Env)).status).toBe(204);
  });
});

describe("budgets on the legacy paths", () => {
  it("pause/reopen share the existing 30/min event-write budget", async () => {
    const { sql } = fakeStore();
    const e = { APP_URL: "https://next.example.test", THROTTLE_STORE: async () => sql } as unknown as EnvWithThrottle;
    const actions = ["publish", "cancel", "rsvp-pause", "rsvp-reopen"];
    const init = { method: "POST", headers: { accept: "application/json" } };
    for (let i = 0; i < 30; i++) {
      expect((await app.request(`/events/abc/${actions[i % actions.length]}`, init, e)).status).toBe(401);
    }
    const res = await app.request("/events/abc/rsvp-reopen", init, e);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
  });

  it("logout: 30 then 429; qa login: 10 then 429", async () => {
    const { sql } = fakeStore();
    const e = {
      APP_URL: "https://next.example.test",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      THROTTLE_STORE: async () => sql,
    } as unknown as EnvWithThrottle;
    const json = { method: "POST", headers: { accept: "application/json" } };
    for (let i = 0; i < 30; i++) expect((await app.request("/logout", json, e)).status).toBe(303);
    expect((await app.request("/logout", json, e)).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await app.request("/auth/qa/x", json, e)).status).not.toBe(429);
    expect((await app.request("/auth/qa/x", json, e)).status).toBe(429);
  });
});
