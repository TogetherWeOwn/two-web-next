import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { assertRouteInventory, assertRouteReferences, routeInventory, type RouteInventoryEntry } from "./helpers/route-inventory";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const inventory: RouteInventoryEntry[] = JSON.parse(read("test/fixtures/route-inventory.json"));
const tests = Object.fromEntries(readdirSync(new URL("test/", root), { recursive: true })
  .filter((path): path is string => typeof path === "string" && path.endsWith(".test.ts") &&
    !["route-inventory.test.ts", "route-inventory-helper.test.ts"].includes(path))
  .map((path) => [`test/${path}`, read(`test/${path}`)]));
const docs = Object.fromEntries(["docs/parity.md", "docs/url-freeze.md"].map((path) => [path, read(path)]));

// Keep this suite DB-free: importing the mounted app only registers handlers.
// Endpoint suites, not this guard or the JSON fixture, own the references.
describe("mounted route inventory", () => {
  it("matches the checked-in method, Hono path and reviewed auth class", () => {
    assertRouteInventory(routeInventory(app), inventory);
  });

  it("has an endpoint-test reference and an exact parity/URL entry for every registration", () => {
    assertRouteReferences(inventory, tests, docs);
  });

  it.each(["GET", "POST", "ALL"])("fails clearly when a dummy %s route is added to the mounted app", (method) => {
    const mounted = new Hono().route("/", app);
    assertRouteInventory(routeInventory(mounted), inventory);
    mounted.on(method, "/dummy-inventory-route", (c) => c.text("dummy"));
    expect(() => assertRouteInventory(routeInventory(mounted), inventory))
      .toThrow(`Added route: ${method} /dummy-inventory-route`);
    expect(() => assertRouteInventory(routeInventory(mounted), inventory))
      .toThrow("Update test/fixtures/route-inventory.json");
  });

  it("detects removal of the mounted moderator middleware", () => {
    const withoutGate = { routes: app.routes.filter((route) => !(route.method === "ALL" && route.path === "/admin/*")) };
    expect(() => assertRouteInventory(routeInventory(withoutGate), inventory))
      .toThrow("Auth changed: GET /admin: moderator -> public");
  });
});
