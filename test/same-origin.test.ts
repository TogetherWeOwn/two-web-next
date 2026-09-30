import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import app from "../src/index";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as memberEnv, MODERATOR } from "./helpers/member-data";
import { SAME_ORIGIN_EXEMPTIONS, UNSAFE_METHODS, sameOrigin } from "../src/same-origin";

const env: Env = { ...memberEnv, APP_URL: "https://two.test/" };
const forbidden = { error: "cross_origin" };

function fixture() {
  const app = new Hono<{ Bindings: Env }>();
  const effect = vi.fn();
  app.use("*", sameOrigin);
  app.all("*", (c) => { effect(); return c.json({ ok: true }); });
  return { app, effect };
}

// Hono records middleware and handlers together. Audit registration order,
// including ALL handlers (such as RSVP's 405 fallback), without deduplicating
// away a newly added unguarded handler or a duplicate guard.
function assertGuarded(router: typeof app) {
  const guards = router.routes.filter((r) => r.handler === sameOrigin);
  expect(guards).toHaveLength(1);
  expect(guards[0]).toMatchObject({ method: "ALL", path: "/*" });
  const guardIndex = router.routes.indexOf(guards[0]!);
  // Only the security-header wrapper may precede it, never a handler.
  expect(guardIndex).toBe(1);
  expect(router.routes[0]).toMatchObject({ method: "ALL", path: "/*" });
  const unsafe = router.routes.filter((r) => UNSAFE_METHODS.some((m) => m === r.method));
  expect(unsafe.length).toBeGreaterThan(0);
  for (const exemption of SAME_ORIGIN_EXEMPTIONS) {
    expect(unsafe.some((r) => r.method === exemption.method && r.path === exemption.path)).toBe(true);
  }
  for (const [index, route] of router.routes.entries()) {
    if (route.handler === sameOrigin || (route.method === "ALL" && route.path === "/*")) continue;
    if (route.method === "ALL" || UNSAFE_METHODS.some((m) => m === route.method)) {
      expect(index, `${route.method} ${route.path} must follow the global guard`).toBeGreaterThan(guardIndex);
    }
  }
}

const writes = [...new Map(app.routes.flatMap((r) => {
  const methods = r.method === "ALL" && !r.path.includes("*") ? UNSAFE_METHODS : [r.method];
  return methods.filter((method) => UNSAFE_METHODS.some((m) => m === method))
    .map((method) => [`${method} ${r.path}`, { method, path: r.path }] as const);
})).values()];
const guarded = writes.filter((r) => !SAME_ORIGIN_EXEMPTIONS.some((e) => e.method === r.method && e.path === r.path));

describe("mounted route same-origin audit", () => {
  it("covers every unsafe registration and only the documented machine exemptions", () => {
    assertGuarded(app);
    expect(SAME_ORIGIN_EXEMPTIONS).toEqual([
      { method: "POST", path: "/api/agent-events" },
      { method: "POST", path: "/csp-reports" },
    ]);
    expect(guarded.length).toBeGreaterThan(0);
  });

  it("detects an unsafe handler registered before the guard", () => {
    const unguarded = new Hono<{ Bindings: Env }>();
    unguarded.post("/bypass", (c) => c.text("unsafe"));
    unguarded.route("/", app);
    expect(() => assertGuarded(unguarded)).toThrow();
  });

  it.each(guarded)("refuses cross-origin $method $path with the one envelope before sessions", async ({ method, path }) => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MODERATOR);
    const get = vi.spyOn(store, "get");
    const create = vi.spyOn(store, "create");
    const revoke = vi.spyOn(store, "revoke");
    const concrete = path.replace(/:[a-z]+/g, "123456789012345678");
    // Filled honeypots must not shortcut the outer guard either.
    const res = await app.request(`https://two.test${concrete}`, {
      method, headers: { cookie, origin: "https://evil.test", accept: "text/html", "content-type": "application/json" },
      body: JSON.stringify({ website: "spam", status: "going" }),
    }, { ...env, SESSION_STORE: store } as Env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("keeps machine ingress and CSP sink independent of Origin", async () => {
    const cases: HeadersInit[] = [{}, { origin: "https://evil.test" }];
    for (const headers of cases) {
      const ingress = await app.request("/api/agent-events", { method: "POST", headers }, env);
      expect(ingress.status).toBe(404); // Disabled machine ingress, not a CSRF denial.
      expect(await ingress.json()).toMatchObject({ reason: "ingress_disabled" });
      const csp = await app.request("/csp-reports", { method: "POST", headers }, env);
      expect(csp.status).toBe(204);
    }
  });
});

describe("same-origin middleware", () => {
  it.each(UNSAFE_METHODS)("refuses untrusted %s before any downstream effect", async (method) => {
    const { app, effect } = fixture();
    const cases: HeadersInit[] = [
      {},
      { origin: "https://evil.test" },
      { origin: "null" },
      { origin: "" },
      { origin: "https://two.test.evil.test" },
      { origin: "http://two.test" },
      { origin: "https://two.test:444" },
      { origin: "https://two.test/path" },
      { origin: "https://two.test/" },
      { origin: "https://two.test https://evil.test" },
      { origin: "https://evil.test", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
    ];
    for (const headers of cases) {
      const res = await app.request("https://two.test/write", { method, headers }, env);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(forbidden);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(UNSAFE_METHODS)("admits %s with Origin or same-origin Fetch Metadata", async (method) => {
    const { app, effect } = fixture();
    const cases: HeadersInit[] = [{ origin: "https://two.test" }, { "sec-fetch-site": "same-origin" }];
    for (const headers of cases) {
      const res = await app.request("https://two.test/write", { method, headers }, env);
      expect(res.status).toBe(200);
    }
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("does not trust Fetch Metadata on an alternate request host", async () => {
    const { app, effect } = fixture();
    const res = await app.request("https://alternate.test/write", {
      method: "POST", headers: { "sec-fetch-site": "same-origin" },
    }, env);
    expect(res.status).toBe(403);
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["", "not a URL", "file:///two", "null"])("fails closed with invalid APP_URL %s", async (APP_URL) => {
    const { app, effect } = fixture();
    const res = await app.request("https://two.test/write", {
      method: "POST", headers: { origin: "https://two.test", "sec-fetch-site": "same-origin" },
    }, { ...env, APP_URL });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden);
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("leaves %s alone", async (method) => {
    const { app, effect } = fixture();
    expect((await app.request("https://two.test/read", { method }, env)).status).toBe(200);
    expect(effect).toHaveBeenCalledOnce();
  });

  it("exempts only the exact machine method/path, not prefixes or other verbs", async () => {
    const { app, effect } = fixture();
    for (const { method, path } of SAME_ORIGIN_EXEMPTIONS) {
      expect((await app.request(`https://two.test${path}`, { method }, env)).status).toBe(200);
      for (const candidate of [`${path}/`, `${path}/write`]) {
        expect((await app.request(`https://two.test${candidate}`, { method }, env)).status).toBe(403);
      }
      for (const candidate of UNSAFE_METHODS.filter((m) => m !== method)) {
        expect((await app.request(`https://two.test${path}`, { method: candidate }, env)).status).toBe(403);
      }
    }
    expect(effect).toHaveBeenCalledTimes(2);
  });
});
