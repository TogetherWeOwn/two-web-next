import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { assertTargetArtifacts } from "./helpers/route-kit-artifacts";
import { assertRouteClassification } from "./helpers/route-kit-classification";
import { assertCompletionDeclarations } from "./helpers/route-kit-completion";
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
    assertRouteClassification(row, row.method, row.path);
    return { method: row.method, path: row.path, auth: row.auth };
  });
  assertRouteInventory(actual, rows);
}

const fixtureClassification = {
  kind: "endpoint",
  scope: "api",
  slice: "API-3",
  family: "ops",
  hono405: false,
};

describe("proposed Kit route snapshot", () => {
  it("matches mounted registration methods, paths and reviewed auth labels", () => {
    assertMapCoverage(routeInventory(app), snapshot);
  });

  it("keeps distinct method and ownership boundaries in the planning map", () => {
    expect(snapshot).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/csp-reports",
          slice: "API-3",
          family: "ops",
        }),
        expect.objectContaining({ method: "GET", path: "/events", scope: "page-cutover" }),
        expect.objectContaining({ method: "POST", path: "/events", slice: "API-7" }),
        expect.objectContaining({
          method: "ALL",
          path: "/events/:key/rsvp",
          kind: "method-fallback",
        }),
        expect.objectContaining({ method: "ALL", path: "/admin/queue/*", kind: "middleware" }),
      ]),
    });
  });

  it("accepts reviewed auth labels with numeric segments", () => {
    const row = {
      method: "GET",
      path: "/fixture",
      auth: "public-draft-403",
      ...fixtureClassification,
    };
    expect(() => assertMapCoverage([row], { ...snapshotObject(), rows: [row] })).not.toThrow();
  });

  it("refuses invalid scope, family, and registration kind even with matching route identity", () => {
    const identity = { method: "GET", path: "/fixture", auth: "public" };
    const row = { ...identity, ...fixtureClassification };
    for (const invalid of [
      identity,
      { ...row, scope: "unknown" },
      { ...row, slice: "API-10" },
      { ...row, family: "machine" },
      { ...row, scope: "page-cutover", slice: null, family: null, source: "unknown" },
      { ...row, scope: "cross-family", slice: null, family: null },
      { ...row, kind: "middleware" },
      { ...row, kind: "method-fallback" },
      { ...row, hono405: true },
    ]) {
      expect(() => assertMapCoverage([identity], { ...snapshotObject(), rows: [invalid] })).toThrow(
        "Invalid route classification: GET /fixture",
      );
    }
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
    const row = { method: "GET", path: "/fixture", auth: "public", ...fixtureClassification };
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

describe("completion declarations", () => {
  it("keeps the planning map free of completion claims", () => {
    assertMapCoverage(routeInventory(app), snapshot);
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      !("rows" in snapshot) ||
      !Array.isArray(snapshot.rows) ||
      !("completion" in snapshot)
    ) {
      throw new Error("Invalid planning route map");
    }
    assertCompletionDeclarations(process.cwd(), snapshot.rows, snapshot.completion);
  });

  it("rejects claims until audited case-level evidence is integrated", () => {
    const root = mkdtempSync(join(tmpdir(), "route-completion-"));
    const target = "web/src/routes/example/+server.ts";
    const source = "src/index.tsx global middleware chain; API-0b";
    const rows = [
      { scope: "api", slice: "API-3", target },
      { scope: "cross-family", source, target },
      { scope: "page-cutover", source, target },
    ];
    const declarations = { apiSlices: [], sources: [], api10: false };
    try {
      expect(() => assertCompletionDeclarations(root, rows, declarations)).not.toThrow();
      expect(() =>
        assertCompletionDeclarations(root, rows, { ...declarations, apiSlices: [""] }),
      ).toThrow("Unknown, empty or duplicate");
      expect(() =>
        assertCompletionDeclarations(root, rows, { ...declarations, sources: ["unknown"] }),
      ).toThrow("Unknown, empty or duplicate");
      expect(() =>
        assertCompletionDeclarations(root, rows, { ...declarations, apiSlices: ["API-4"] }),
      ).toThrow("Empty slice claim");
      expect(() =>
        assertCompletionDeclarations(root, rows, { ...declarations, apiSlices: ["API-3"] }),
      ).toThrow("Missing regular file");
      expect(() =>
        assertCompletionDeclarations(root, [{ ...rows[0], target: null }], {
          ...declarations,
          apiSlices: ["API-3"],
        }),
      ).toThrow("Unresolved or invalid target");
      mkdirSync(dirname(join(root, target)), { recursive: true });
      writeFileSync(join(root, target), "fixture");
      for (const claim of [
        { ...declarations, apiSlices: ["API-3"] },
        { ...declarations, sources: [source] },
        { ...declarations, api10: true },
      ]) {
        expect(() => assertCompletionDeclarations(root, rows, claim)).toThrow(
          "Completion requires audited case-level evidence",
        );
      }
      for (const sourceName of [
        source,
        "src/index.tsx admin middleware chain; API-0b",
        "docs/adr/0001-sveltekit-page-renderer.md#page-families-move-to-kit-before-m0",
      ]) {
        expect(() =>
          assertCompletionDeclarations(
            root,
            [{ scope: "page-cutover", source: sourceName, target }],
            {
              ...declarations,
              sources: [sourceName],
            },
          ),
        ).toThrow("Completion requires audited case-level evidence");
      }
      const namedTarget = "web/src/routes/[id=number]/+server.ts";
      mkdirSync(dirname(join(root, namedTarget)), { recursive: true });
      writeFileSync(join(root, namedTarget), "fixture");
      expect(() =>
        assertCompletionDeclarations(root, [{ ...rows[0], target: namedTarget }], {
          ...declarations,
          apiSlices: ["API-3"],
        }),
      ).toThrow("Named matcher targets are unsupported");
      for (const slice of ["API-3", "API-4", "API-5", "API-6", "API-7", "API-8", "API-9"]) {
        expect(() =>
          assertCompletionDeclarations(root, [{ scope: "api", slice, target }], {
            ...declarations,
            apiSlices: [slice],
          }),
        ).toThrow("Completion requires audited case-level evidence");
      }
      expect(() =>
        assertCompletionDeclarations(root, rows, { ...declarations, api10: "yes" }),
      ).toThrow("Invalid completion declarations");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("synthetic case admission (not route parity)", () => {
  it("joins each reviewed candidate to exactly one passed case in the expected context", () => {
    const root = mkdtempSync(join(tmpdir(), "route-evidence-"));
    const target = "web/src/routes/example/+server.ts";
    const rows = [{ scope: "api", slice: "API-3", target }];
    const claim = { apiSlices: ["API-3"], sources: [], api10: false };
    const context = { sha: "synthetic-sha", run: "run-1", attempt: "1", inputs: "digest" };
    const candidate = { claim: "API-3", row: 0, id: "GET /example:ok", branch: "ok" };
    const obligation = { ...candidate, state: "required" as const, selectors: ["test:ok"] };
    const result = {
      selector: "test:ok",
      obligation: candidate.id,
      branch: "ok",
      status: "passed",
    };
    const fixture = {
      expected: context,
      execution: { ...context },
      candidates: [candidate],
      obligations: [obligation],
      cases: [result],
    };
    try {
      mkdirSync(dirname(join(root, target)), { recursive: true });
      writeFileSync(join(root, target), "fixture");
      expect(() => assertCompletionDeclarations(root, rows, claim, fixture)).not.toThrow();
      const variants = [
        { ...fixture, candidates: [] },
        { ...fixture, obligations: [] },
        { ...fixture, obligations: [{ ...obligation, state: "unresolved" as const }] },
        { ...fixture, obligations: [{ ...obligation, selectors: [] }] },
        { ...fixture, cases: [] },
        { ...fixture, cases: [{ ...result, status: "skipped" }] },
        { ...fixture, cases: [{ ...result, status: "failed" }] },
        { ...fixture, cases: [result, result] },
        { ...fixture, cases: [{ ...result, branch: "error" }] },
        { ...fixture, cases: [{ ...result, obligation: "GET /other:ok" }] },
        { ...fixture, execution: { ...context, sha: "other" } },
        { ...fixture, execution: { ...context, attempt: "2" } },
        { ...fixture, execution: { ...context, run: "run-2" } },
        { ...fixture, execution: { ...context, inputs: "other" } },
      ];
      for (const evidence of variants) {
        expect(() => assertCompletionDeclarations(root, rows, claim, evidence)).toThrow(
          "Completion requires audited case-level evidence",
        );
      }
      expect(() =>
        assertCompletionDeclarations(root, rows, { ...claim, api10: true }, fixture),
      ).toThrow("Completion requires audited case-level evidence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
