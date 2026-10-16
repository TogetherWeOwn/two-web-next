// Static public leaves enablement acceptance: the shipped manifest owns
// GET /about and GET /faq on Kit.
//
// Enablement flips exactly two entries (`enabled: false` -> `true`) with the
// same public-read declaration; every other entry stays unchanged, and
// returning both entries to `enabled: false` restores Hono ownership as the
// rollback. These cases pin the shipped manifest (no override) so they fail
// while the leaves are held on Hono and pass once the enablement lands.
// Hermetic: manifest + gate derivation + dispatch with mocked resolve/hono,
// no network, no staging/production. Test files only: no source changes here.
import { describe, expect, it, vi } from "vitest";
import {
  decideRoute,
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  resolveRouteOwner,
  ROUTE_MANIFEST,
  type OwnedRoute,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";

const get = (path: string) => new Request(new URL(path, APP_URL).href, { method: "GET" });

const eventFor = (path: string, method = "GET") => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: path } };
};

const depsFor = () => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: vi.fn(async () => new Response("kit")),
});

describe("static leaves enablement acceptance (shipped manifest)", () => {
  it("owns GET /about on Kit", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/about" })).toBe("kit");
  });

  it("owns GET /faq on Kit", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/faq" })).toBe("kit");
  });

  it("lets HEAD follow the GET entries to Kit and keeps POST on Hono", () => {
    expect(resolveRouteOwner({ method: "HEAD", path: "/about" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/faq" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/about" })).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/faq" })).toBe("hono");
  });

  it("treats the Kit data requests like their pages", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/about/__data.json" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/faq/__data.json" })).toBe("kit");
  });

  it("declares the exact public read on both Kit decisions", () => {
    expect(decideRoute(get("/about"))?.reads).toBe("public");
    expect(decideRoute(get("/faq"))?.reads).toBe("public");
  });

  it("ships both enabled entries with the exact method/path/reads", () => {
    for (const path of ["/about", "/faq"]) {
      const entry = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === path);
      expect(entry, `missing manifest entry GET ${path}`).toBeDefined();
      expect(entry?.enabled).toBe(true);
      expect(entry?.reads).toBe("public");
    }
  });

  it("ships the full manifest with only /about and /faq flipped to enabled", () => {
    expect(ROUTE_MANIFEST).toEqual([
      { method: "GET", path: "/", enabled: false, reads: "public" },
      { method: "GET", path: "/events/past", enabled: true, reads: "public" },
      { method: "GET", path: "/events", enabled: false, reads: "public" },
      { method: "GET", path: "/about", enabled: true, reads: "public" },
      { method: "GET", path: "/privacy", enabled: false, reads: "public" },
      { method: "GET", path: "/rules", enabled: false, reads: "public" },
      { method: "GET", path: "/faq", enabled: true, reads: "public" },
      { method: "GET", path: "/join", enabled: false, reads: "public" },
      {
        method: "GET",
        path: "/admin",
        enabled: false,
        reads: { resource: "dashboard", action: "view", route: "admin.dashboard" },
      },
      {
        method: "GET",
        path: "/admin/featured",
        enabled: false,
        reads: { resource: "featured_contents", action: "list", route: "admin.featured.index" },
      },
      {
        method: "GET",
        path: "/admin/featured/new",
        enabled: false,
        reads: { resource: "featured_contents", action: "view", route: "admin.featured.create" },
      },
      {
        method: "GET",
        path: "/admin/featured/:id",
        enabled: false,
        reads: { resource: "featured_contents", action: "view", route: "admin.featured.edit" },
      },
      {
        method: "GET",
        path: "/admin/activity-log",
        enabled: false,
        reads: { resource: "activity_log", action: "list", route: "admin.activity-log.index" },
      },
      {
        method: "GET",
        path: "/admin/events",
        enabled: false,
        reads: { resource: "events", action: "list", route: "admin.events.index" },
      },
      {
        method: "GET",
        path: "/admin/events/new",
        enabled: false,
        reads: { resource: "events", action: "view", route: "admin.events.create" },
      },
      { method: "GET", path: "/admin/events/create", enabled: false },
      {
        method: "GET",
        path: "/admin/events/:key",
        enabled: false,
        reads: { resource: "events", action: "view", route: "admin.events.edit" },
      },
      {
        method: "GET",
        path: "/admin/join-attempts",
        enabled: false,
        reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
      },
      {
        method: "GET",
        path: "/admin/join-attempts/:id",
        enabled: false,
        reads: { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" },
      },
      { method: "GET", path: "/auth/recover", enabled: false, reads: "public" },
      {
        method: "GET",
        path: "/profile",
        enabled: false,
        reads: { resource: "profile", action: "view", route: "profile" },
      },
      {
        method: "GET",
        path: "/members/:user",
        enabled: false,
        reads: { resource: "profile", action: "view", route: "profiles.show" },
      },
      { method: "GET", path: "/hotzones", enabled: true, reads: "public" },
      { method: "GET", path: "/hotzones/joins", enabled: true, reads: "public" },
      { method: "GET", path: "/hotzones/voice", enabled: true, reads: "public" },
      { method: "GET", path: "/hotzones/games", enabled: true, reads: "public" },
      {
        method: "GET",
        path: "/leaderboards/members",
        enabled: true,
        reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" },
      },
      {
        method: "GET",
        path: "/e/:key",
        enabled: false,
        reads: { resource: "member", action: "list", route: "events.page" },
      },
    ]);
  });

  it("dispatches /about to resolve with the Kit marker, never to Hono", async () => {
    const event = eventFor("/about");
    const deps = depsFor();
    const response = await dispatchHookRequest(event, deps);
    expect(deps.resolve).toHaveBeenCalledOnce();
    expect(deps.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("dispatches /faq to resolve with the Kit marker, never to Hono", async () => {
    const event = eventFor("/faq");
    const deps = depsFor();
    const response = await dispatchHookRequest(event, deps);
    expect(deps.resolve).toHaveBeenCalledOnce();
    expect(deps.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("keeps the disabled /rules control on Hono with no Kit marker", async () => {
    expect(resolveRouteOwner({ method: "GET", path: "/rules" })).toBe("hono");
    expect(decideRoute(get("/rules"))).toBeUndefined();
    const event = eventFor("/rules");
    const deps = depsFor();
    const response = await dispatchHookRequest(event, deps);
    expect(deps.honoFetch).toHaveBeenCalledOnce();
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(await response.text()).toBe("hono");
  });

  it("rollback: a disabled copy restores Hono ownership for both leaves", async () => {
    const rolledBack: OwnedRoute[] = ROUTE_MANIFEST.map((entry) =>
      entry.method === "GET" && (entry.path === "/about" || entry.path === "/faq")
        ? { ...entry, enabled: false }
        : entry,
    );
    expect(rolledBack.find((e) => e.method === "GET" && e.path === "/about")?.enabled).toBe(false);
    expect(rolledBack.find((e) => e.method === "GET" && e.path === "/faq")?.enabled).toBe(false);
    for (const decision of [
      { method: "GET", path: "/about" },
      { method: "HEAD", path: "/about" },
      { method: "GET", path: "/about/__data.json" },
      { method: "GET", path: "/faq" },
      { method: "HEAD", path: "/faq" },
      { method: "GET", path: "/faq/__data.json" },
    ]) {
      expect(resolveRouteOwner(decision, rolledBack), `${decision.method} ${decision.path}`).toBe(
        "hono",
      );
    }
    expect(decideRoute(get("/about"), rolledBack)).toBeUndefined();
    expect(decideRoute(get("/faq"), rolledBack)).toBeUndefined();
    for (const path of ["/about", "/faq"]) {
      const event = eventFor(path);
      const deps = { ...depsFor(), manifest: rolledBack };
      const response = await dispatchHookRequest(event, deps);
      expect(deps.honoFetch).toHaveBeenCalledOnce();
      expect(deps.resolve).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
      expect(await response.text()).toBe("hono");
    }
  });
});
