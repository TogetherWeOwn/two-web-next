import { describe, expect, it } from "vitest";
import { allowedMethodsFor, decideOwner, resolveRouteOwner } from "../src/route-ownership";

const get = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, { method: "GET", ...init });

// The ownership contract for the SvelteKit strangler: one method-aware,
// server-controlled decision per request, made before Kit resolve and before
// any auth/body read. Hono is the default; a native route renders in Kit only
// when its manifest entry is explicitly enabled.
describe("route ownership", () => {
  it("sends unknown paths to Hono", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/some-key" })).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/events" })).toBe("hono");
  });

  it("keeps the only native page on Hono until its flag is enabled", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" })).toBe("hono");
  });

  it("routes an enabled native page to Kit", () => {
    const owner = resolveRouteOwner({ method: "GET", path: "/events/past" }, [
      { method: "GET", path: "/events/past", enabled: true },
    ]);
    expect(owner).toBe("kit");
  });

  it("treats a disabled native entry exactly like an unknown path", () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: false }];
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" }, manifest)).toBe("hono");
  });

  it("matches methods independently: POST/PATCH siblings stay on Hono", () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    expect(resolveRouteOwner({ method: "PATCH", path: "/events/past" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/events/past" }, manifest)).toBe("hono");
    expect(
      resolveRouteOwner({ method: "POST", path: "/events/past" }, [
        { method: "GET", path: "/events/past", enabled: true },
        { method: "POST", path: "/events/past", enabled: true },
      ]),
    ).toBe("kit");
  });

  it("lets HEAD follow the matching GET entry", () => {
    expect(resolveRouteOwner({ method: "HEAD", path: "/events/past" })).toBe("hono");
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    expect(resolveRouteOwner({ method: "HEAD", path: "/events/past" }, manifest)).toBe("kit");
  });

  it("prefers an exact static entry over a dynamic pattern", () => {
    const manifest = [
      { method: "GET", path: "/events/:key", enabled: true },
      { method: "GET", path: "/events/past", enabled: false },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/spring-fete" }, manifest)).toBe("kit");
  });

  it("prefers the more specific dynamic pattern", () => {
    const manifest = [
      { method: "GET", path: "/:group/:key", enabled: false },
      { method: "GET", path: "/events/:key", enabled: true },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/events/spring-fete" }, manifest)).toBe("kit");
  });

  it("ignores trailing slashes when matching", () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    expect(resolveRouteOwner({ method: "GET", path: "/events/past/" }, manifest)).toBe("kit");
  });

  it("never lets a manifest entry shadow a reserved API", () => {
    const manifest = [
      { method: "POST", path: "/api/agent-events", enabled: true },
      { method: "GET", path: "/up", enabled: true },
      { method: "POST", path: "/csp-reports", enabled: true },
    ];
    expect(resolveRouteOwner({ method: "POST", path: "/api/agent-events" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/api/anything-new" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/up" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/csp-reports" }, manifest)).toBe("hono");
  });

  it("treats a Kit data request like the page it loads", () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    expect(resolveRouteOwner({ method: "GET", path: "/events/past/__data.json" }, manifest)).toBe(
      "kit",
    );
    expect(resolveRouteOwner({ method: "GET", path: "/events/past/__data.json" })).toBe("hono");
  });

  it("lists the enabled Kit methods for a path, for Allow/405 semantics", () => {
    const manifest = [
      { method: "GET", path: "/events/past", enabled: true },
      { method: "POST", path: "/events/past", enabled: false },
    ];
    expect(allowedMethodsFor("/events/past", manifest)).toEqual(["GET"]);
    expect(allowedMethodsFor("/events/past")).toEqual([]);
    expect(allowedMethodsFor("/up", [{ method: "GET", path: "/up", enabled: true }])).toEqual([]);
  });
});

describe("decideOwner over a real Request", () => {
  it("decides from method and path only, preserving the query for the renderer", () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    expect(decideOwner(get("/events/past?page=2"), manifest)).toBe("kit");
    expect(decideOwner(get("/nope?page=2"), manifest)).toBe("hono");
  });

  it("reads neither headers, cookies, body, nor override hints", async () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    const request = new Request("http://localhost/events/past?renderer=hono", {
      headers: { "x-renderer": "hono", cookie: "renderer=kit" },
    });
    expect(decideOwner(request, manifest)).toBe("kit");
    expect(request.bodyUsed).toBe(false);
  });

  it("leaves a POST body unread for the renderer that owns it", async () => {
    const request = new Request("http://localhost/events", {
      method: "POST",
      body: JSON.stringify({ title: "Seed swap" }),
      headers: { "content-type": "application/json" },
    });
    expect(decideOwner(request)).toBe("hono");
    expect(request.bodyUsed).toBe(false);
    await expect(request.json()).resolves.toMatchObject({ title: "Seed swap" });
  });

  it("treats data-fetch query strings as part of the page decision", () => {
    const manifest = [{ method: "GET", path: "/events/past", enabled: true }];
    expect(decideOwner(get("/events/past/__data.json?x-sveltekit-invalidated=011"), manifest)).toBe(
      "kit",
    );
  });
});
