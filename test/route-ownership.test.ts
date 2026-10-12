import { describe, expect, it } from "vitest";
import { decideOwner, resolveRouteOwner } from "../src/route-ownership";

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
      { method: "GET", path: "/api", enabled: true },
      { method: "GET", path: "/up", enabled: true },
      { method: "POST", path: "/csp-reports", enabled: true },
    ];
    expect(resolveRouteOwner({ method: "POST", path: "/api/agent-events" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/api/anything-new" }, manifest)).toBe("hono");
    // The bare prefix stays reserved after trailing-slash normalization.
    expect(resolveRouteOwner({ method: "GET", path: "/api" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/api/" }, manifest)).toBe("hono");
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

  it("claims a :param pattern only with the same segment count and static segments", () => {
    const manifest = [{ method: "GET", path: "/events/:key", enabled: true }];
    expect(resolveRouteOwner({ method: "GET", path: "/events/spring-fete" }, manifest)).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/events" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/a/b" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/nope/x" }, manifest)).toBe("hono");
  });

  it("breaks equal-specificity pattern ties by manifest order", () => {
    const manifest = [
      { method: "GET", path: "/:a/x", enabled: true },
      { method: "GET", path: "/y/:b", enabled: false },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/y/x" }, manifest)).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/y/x" }, [...manifest].reverse())).toBe(
      "hono",
    );
  });

  it("decodes percent escapes like Kit before matching, so encoded aliases cannot bypass a rollback", () => {
    // %70 is "p": /events/%70ast decodes to /events/past.
    const manifest = [
      { method: "GET", path: "/events/:key", enabled: true },
      { method: "GET", path: "/events/past", enabled: false },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/%70ast" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/spring-fete" }, manifest)).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/events/%73pring-fete" }, manifest)).toBe(
      "kit",
    );
  });

  it("decodes before the reserved guard, so encoded /api cannot be shadowed", () => {
    // %61 is "a": /%61pi decodes to /api.
    const manifest = [{ method: "GET", path: "/:group/agent-events", enabled: true }];
    expect(resolveRouteOwner({ method: "GET", path: "/api/agent-events" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/%61pi/agent-events" }, manifest)).toBe(
      "hono",
    );
  });

  it("fails closed to Hono on malformed escapes and preserves literal %25 like Kit", () => {
    const manifest = [{ method: "GET", path: "/events/:key", enabled: true }];
    expect(resolveRouteOwner({ method: "GET", path: "/events/%ZZ" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/%" }, manifest)).toBe("hono");
    // %25 is a literal "%": Kit leaves it untouched to avoid double-decoding.
    expect(resolveRouteOwner({ method: "GET", path: "/events/%25" }, manifest)).toBe("kit");
  });

  it("treats an encoded data suffix like the literal page suffix", () => {
    // %5F is "_": %5F%5Fdata.json decodes to __data.json.
    const enabled = [{ method: "GET", path: "/events/past", enabled: true }];
    const disabled = [{ method: "GET", path: "/events/past", enabled: false }];
    expect(
      resolveRouteOwner({ method: "GET", path: "/events/past/%5F%5Fdata.json" }, enabled),
    ).toBe("kit");
    expect(
      resolveRouteOwner({ method: "GET", path: "/events/past/%5F%5Fdata.json" }, disabled),
    ).toBe("hono");
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
