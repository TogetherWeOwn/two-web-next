import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import {
  assertRouteInventory,
  routeInventory,
  type RouteInventoryEntry,
} from "./helpers/route-inventory";

const snapshot: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/route-kit-map.json", import.meta.url), "utf8"),
);

function assertMapCoverage(actual: RouteInventoryEntry[], map: unknown) {
  if (
    !map ||
    typeof map !== "object" ||
    !("schema" in map) ||
    map.schema !== 1 ||
    !("status" in map) ||
    map.status !== "planning-only" ||
    !("live" in map) ||
    map.live !== false ||
    !("rows" in map) ||
    !Array.isArray(map.rows)
  ) {
    throw new Error("Invalid planning route map");
  }

  const rows: RouteInventoryEntry[] = map.rows.map((row: unknown, index: number) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("method" in row) ||
      typeof row.method !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(row.method) ||
      !("path" in row) ||
      typeof row.path !== "string" ||
      !row.path.startsWith("/") ||
      /[\r\n]/.test(row.path) ||
      !("auth" in row) ||
      typeof row.auth !== "string" ||
      !/^[a-z]+(?:-[a-z]+)*$/.test(row.auth)
    ) {
      throw new Error(`Invalid route map row: ${index}`);
    }
    return { method: row.method, path: row.path, auth: row.auth };
  });
  assertRouteInventory(actual, rows);
}

describe("proposed Kit route snapshot", () => {
  it("matches mounted registration methods, paths and reviewed auth labels", () => {
    assertMapCoverage(routeInventory(app), snapshot);
  });

  it("rejects a newly mounted registration absent from the map", () => {
    const router = new Hono();
    const child = new Hono();
    child.get("/fake-mounted-route", (c) => c.text("fixture"));
    router.route("/fixture", child);
    expect(() => assertMapCoverage(routeInventory(router), { ...snapshotObject(), rows: [] })).toThrow(
      "Added route: GET /fixture/fake-mounted-route",
    );
  });

  it("rejects stale, duplicate, invalid and auth-mismatched rows", () => {
    const router = new Hono();
    router.get("/fixture", (c) => c.text("fixture"));
    const actual = routeInventory(router);
    const row = { method: "GET", path: "/fixture", auth: "public" };
    const check = (rows: unknown[]) => () => assertMapCoverage(actual, { ...snapshotObject(), rows });
    expect(check([{ ...row, path: "/stale" }])).toThrow("Removed route: GET /stale");
    expect(check([row, row])).toThrow("Duplicate method/path");
    expect(check([{ ...row, method: "get" }])).toThrow("Invalid route map row: 0");
    expect(check([{ ...row, path: null }])).toThrow("Invalid route map row: 0");
    expect(check([{ ...row, auth: "" }])).toThrow("Invalid route map row: 0");
    expect(check([{ ...row, auth: "member" }])).toThrow("Auth changed: GET /fixture");
    expect(() => assertMapCoverage(actual, { ...snapshotObject(), live: true })).toThrow(
      "Invalid planning route map",
    );
  });
});

function snapshotObject() {
  return { schema: 1, status: "planning-only", live: false };
}
