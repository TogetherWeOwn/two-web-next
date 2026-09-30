import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { assertRouteInventory, assertRouteReferences, routeInventory, type RouteInventoryEntry } from "./helpers/route-inventory";

const saved: RouteInventoryEntry[] = [{ method: "GET", path: "/known", auth: "public" }];

const routes = (app: Hono): RouteInventoryEntry[] => app.routes.map(({ method, path }) => ({
  method, path, auth: "public",
}));

describe("route inventory diagnostics", () => {
  it("rejects a dummy route added to app.routes with update instructions", () => {
    const app = new Hono();
    app.get("/known", (c) => c.text("ok"));
    assertRouteInventory(routes(app), saved);
    app.post("/dummy", (c) => c.text("new"));
    expect(() => assertRouteInventory(routes(app), saved)).toThrow("Added route: POST /dummy (auth: public)");
    expect(() => assertRouteInventory(routes(app), saved)).toThrow("Update test/fixtures/route-inventory.json");
  });

  it("reports deleted routes", () => {
    expect(() => assertRouteInventory([], saved)).toThrow("Removed route: GET /known");
  });

  it("reports auth-class drift", () => {
    expect(() => assertRouteInventory([{ ...saved[0]!, auth: "session" }], saved))
      .toThrow("Auth changed: GET /known: public -> session");
  });

  it("rejects duplicate inventory entries", () => {
    expect(() => assertRouteInventory(saved, [...saved, ...saved]))
      .toThrow("Duplicate method/path in route-inventory.json");
  });

  it("reports a method change as a removed and an added route", () => {
    const changed = [{ ...saved[0]!, method: "POST" }];
    expect(() => assertRouteInventory(changed, saved)).toThrow("Added route: POST /known");
    expect(() => assertRouteInventory(changed, saved)).toThrow("Removed route: GET /known");
  });

  it("rejects duplicate extracted endpoints", () => {
    expect(() => assertRouteInventory([...saved, ...saved], saved))
      .toThrow("Duplicate method/path in app.routes");
  });

  it("collapses stacked handlers but keeps ALL middleware and fallbacks", () => {
    const app = new Hono();
    app.use("*", async (_c, next) => next());
    app.post("/known", async (_c, next) => next(), (c) => c.text("ok"));
    app.all("/fallback", (c) => c.body(null, 405));
    expect(routeInventory(app)).toEqual([
      { method: "ALL", path: "/*", auth: "middleware" },
      { method: "ALL", path: "/fallback", auth: "public" },
      { method: "POST", path: "/known", auth: "public" },
    ]);
  });

  it("requires explicit method/pattern references, not URL substrings or another verb", () => {
    const docs = { "docs/parity.md": "| `GET /known` | mapped |" };
    for (const source of ["app.request('/known')", "// route-inventory: POST /known", "// route-inventory: GET /known-extra"]) {
      expect(() => assertRouteReferences(saved, { "test/endpoint.test.ts": source }, docs))
        .toThrow("Missing test reference: GET /known");
    }
  });

  it("reports deleted test references with repair instructions", () => {
    expect(() => assertRouteReferences(saved, {}, { "docs/parity.md": "`GET /known`" }))
      .toThrow("Add // route-inventory: METHOD /pattern");
  });

  it("requires an exact documented method/path, not a wildcard or method mismatch", () => {
    for (const doc of ["`GET /known-extra`", "`POST /known`", "`GET /*`", "GET /known"]) {
      expect(() => assertRouteReferences(saved, { "test/endpoint.test.ts": "// route-inventory: GET /known" }, { "docs/parity.md": doc }))
        .toThrow("Missing parity/URL entry: GET /known");
    }
  });

  it("accepts a reference in either doc and checks stale test declarations", () => {
    const tests = { "test/endpoint.test.ts": "// route-inventory: GET /known\r\n" };
    const docs = { "docs/parity.md": "", "docs/url-freeze.md": "`GET /known`" };
    expect(() => assertRouteReferences(saved, tests, docs)).not.toThrow();
    expect(() => assertRouteReferences([], tests, docs)).toThrow("Stale test reference: GET /known");
  });

  it("ignores inventory ordering", () => {
    const second = { method: "POST", path: "/known", auth: "public" };
    expect(() => assertRouteInventory([...saved, second], [second, ...saved])).not.toThrow();
  });
});
