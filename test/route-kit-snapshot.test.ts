import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { assertTargetArtifacts } from "./helpers/route-kit-artifacts";
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
      !/^[a-z]+(?:-[a-z0-9]+)*$/.test(row.auth)
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

  it("accepts reviewed auth labels with numeric segments", () => {
    const row = { method: "GET", path: "/fixture", auth: "public-draft-403" };
    expect(() => assertMapCoverage([row], { ...snapshotObject(), rows: [row] })).not.toThrow();
  });

  it("rejects a newly mounted registration absent from the map", () => {
    const router = new Hono();
    const child = new Hono();
    child.get("/fake-mounted-route", (c) => c.text("fixture"));
    router.route("/fixture", child);
    expect(() =>
      assertMapCoverage(routeInventory(router), { ...snapshotObject(), rows: [] }),
    ).toThrow("Added route: GET /fixture/fake-mounted-route");
  });

  it("rejects stale, duplicate, invalid and auth-mismatched rows", () => {
    const router = new Hono();
    router.get("/fixture", (c) => c.text("fixture"));
    const actual = routeInventory(router);
    const row = { method: "GET", path: "/fixture", auth: "public" };
    const check = (rows: unknown[]) => () =>
      assertMapCoverage(actual, { ...snapshotObject(), rows });
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

describe("completed target artifact prerequisites", () => {
  it("distinguishes unresolved targets and each missing artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "route-artifacts-"));
    const page = "web/src/routes/[id]/+page.svelte";
    const load = "web/src/routes/[id]/+page.server.ts";
    const matcher = "web/src/params.ts";
    const add = (path: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "fixture");
    };
    try {
      expect(() => assertTargetArtifacts(root, { state: "unresolved" })).toThrow(
        "Unresolved or invalid target",
      );
      expect(() => assertTargetArtifacts(root, "web/src/routes/../+server.ts")).toThrow(
        "Unresolved or invalid target",
      );
      expect(() => assertTargetArtifacts(root, page)).toThrow(`Missing regular file: ${page}`);
      mkdirSync(join(root, page), { recursive: true });
      expect(() => assertTargetArtifacts(root, page)).toThrow(`Missing regular file: ${page}`);
      rmSync(join(root, page), { recursive: true });
      add(page);
      expect(() => assertTargetArtifacts(root, page)).toThrow(`Missing regular file: ${load}`);
      add(load);
      expect(() => assertTargetArtifacts(root, page)).not.toThrow();
      const endpoint = "web/src/routes/+server.ts";
      add(endpoint);
      expect(() => assertTargetArtifacts(root, endpoint)).not.toThrow();
      const newlineTarget = "web/src/routes/+server.ts\n";
      add(newlineTarget);
      expect(() => assertTargetArtifacts(root, newlineTarget)).toThrow(
        "Unresolved or invalid target",
      );
      const grouped = "web/src/routes/(legacy-[id=number])/about/+server.ts";
      add(grouped);
      expect(() => assertTargetArtifacts(root, grouped)).not.toThrow();
      const namedTargets = [
        "web/src/routes/(legacy-[ignored=number])/[id=number]/+server.ts",
        "web/src/routes/[id=event-key]/+server.ts",
        "web/src/routes/[id=123]/+server.ts",
        "web/src/routes/[[id=event-key]]/+server.ts",
        "web/src/routes/[...id=123]/+server.ts",
      ];
      for (const target of namedTargets) {
        add(target);
        expect(() => assertTargetArtifacts(root, target)).toThrow(
          "Named matcher targets are unsupported",
        );
      }
      add(matcher);
      mkdirSync(join(root, "web/src/params/index.ts"), { recursive: true });
      for (const target of namedTargets) {
        expect(() => assertTargetArtifacts(root, target)).toThrow(
          "Named matcher targets are unsupported",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function snapshotObject() {
  return { schema: 1, status: "planning-only", live: false };
}
