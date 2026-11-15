import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, it } from "vitest";
import app from "../src/index";
import {
  assertRouteInventory,
  routeInventory,
  type RouteInventoryEntry,
} from "./helpers/route-inventory";

const snapshot: { rows: RouteInventoryEntry[] } = JSON.parse(
  readFileSync(new URL("./fixtures/route-kit-map.json", import.meta.url), "utf8"),
);

describe("proposed Kit route snapshot", () => {
  it("matches mounted registration methods, paths and reviewed auth labels", () => {
    assertRouteInventory(routeInventory(app), snapshot.rows);
  });
});
