import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explicitMethodRefusal } from "../src/http/method";
import { decideOwner, resolveRouteOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { coverage } from "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/index.json";
import inventory from "./fixtures/route-inventory.json";
import { rows } from "./fixtures/route-kit-map.json";
import {
  familyEndpointKeys,
  projectFixtureOwner,
  routeKey,
} from "./helpers/route-ownership-matrix";

const goldenDir = new URL(
  "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/",
  import.meta.url,
);
// Read the snapshot as data; do not load the Worker recorder in Vitest.
const recording = new Map(
  ["routes", "kit", "static"].flatMap((section) => {
    const dir = new URL(`${section}/`, goldenDir);
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => [
        `${section}/${file}`,
        JSON.parse(readFileSync(new URL(file, dir), "utf8")).vectors,
      ]);
  }),
);
const registrationKeys = new Set(inventory.map(routeKey));
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const families = [
  ["ops", "API-3", 20],
  ["assets", null, 0],
  ["feeds", "API-4", 5],
  ["public-api", "API-4", 5],
  ["admin", "API-5", 20],
  ["auth", "API-6", 9],
  ["event-writes", "API-7", 10],
  ["member-writes", "API-8", 4],
  ["machine", "API-9", 3],
];
const fallbackKeys = [
  "ALL /events/:key/rsvp",
  ...["/admin/ops-overrides", "/admin/queue/source-evidence/:id"].flatMap((path) =>
    ["DELETE", "OPTIONS", "PATCH", "POST", "PUT"].map((method) => routeKey({ method, path })),
  ),
];
const middlewareKeys = [
  "/*",
  "/admin/*",
  "/admin/queue/*",
  "/leaderboards/members",
  "/members/*",
  "/profile",
].map((path) => routeKey({ method: "ALL", path }));
const nonEndpoints = new Set([...fallbackKeys, ...middlewareKeys]);

describe("route ownership preparation matrix (not runtime dispatch)", () => {
  it.each(families)("selects only %s endpoint registration pairs", (family, slice, count) => {
    // Classify by the reviewed migration slice, not by the family or kind under test.
    const expected = rows.filter((row) => {
      if (slice === null || row.slice !== slice || nonEndpoints.has(routeKey(row))) return false;
      if (slice !== "API-4") return true;
      const publicApi = row.path.startsWith("/api/public/") || row.path === "/openapi.json";
      return family === "public-api" ? publicApi : !publicApi;
    });
    const selection = familyEndpointKeys(rows, family);
    expect(selection.size).toBe(count);
    expect(selection).toEqual(new Set(expected.map(routeKey)));
    const changed = rows.filter(
      (row) => projectFixtureOwner(row, selection, () => "hono") === "kit",
    );
    expect(changed).toEqual(expected);
    for (const key of selection) expect(registrationKeys.has(key), key).toBe(true);
  });

  it("accounts for separately classified endpoints, method fallbacks, middleware and assets", () => {
    const names = new Set(families.map(([family]) => family));
    const tagged = rows.filter((row) => row.kind === "endpoint" && row.family !== null);
    expect(tagged).toHaveLength(76);
    for (const row of tagged) {
      expect(names.has(row.family), routeKey(row)).toBe(true);
      expect(methods).toContain(row.method);
    }
    const keysFor = (kind) => rows.filter((row) => row.kind === kind).map(routeKey);
    expect(keysFor("method-fallback").sort()).toEqual([...fallbackKeys].sort());
    expect(keysFor("middleware").sort()).toEqual([...middlewareKeys].sort());
    const assets = [...recording].filter(([file]) => file.startsWith("static/"));
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.map(([, vectors]) => `STATIC ${routeKey(vectors.GET.request)}`).sort()).toEqual(
      coverage
        .filter(({ entry }) => entry.startsWith("STATIC "))
        .map(({ entry }) => entry)
        .sort(),
    );
  });

  it.each([
    ["event-writes", "/events", "kit"],
    ["admin", "/admin/events", "hono"],
  ])(
    "selects the %s POST while preserving the current GET and HEAD owners",
    (family, path, reader) => {
      const selection = familyEndpointKeys(rows, family);
      const off = new Set();
      const write = { method: "POST", path };
      const manifest = [{ ...write, enabled: true }, ...ROUTE_MANIFEST];
      expect(projectFixtureOwner(write, off, resolveRouteOwner)).toBe("hono");
      expect(projectFixtureOwner(write, selection, resolveRouteOwner)).toBe("kit");
      expect(resolveRouteOwner(write, manifest)).toBe("kit");
      for (const method of ["GET", "HEAD"]) {
        const read = { method, path };
        expect(selection.has(routeKey(read))).toBe(false);
        expect(projectFixtureOwner(read, off, resolveRouteOwner)).toBe(reader);
        expect(projectFixtureOwner(read, selection, resolveRouteOwner)).toBe(reader);
        expect(resolveRouteOwner(read, manifest)).toBe(reader);
      }
    },
  );

  it.each([
    ["/up", "/version", ["GET", "HEAD"], "GET"],
    ["/csp-reports", "/version", ["POST"], "POST"],
  ])(
    "releases only the enabled reserved method and path for %s",
    (path, sibling, released, registered) => {
      expect(familyEndpointKeys(rows, "ops").has(routeKey({ method: registered, path }))).toBe(
        true,
      );
      const selection = new Set(released.map((method) => routeKey({ method, path })));
      const probes = [path, sibling, `${path}/`].flatMap((candidate) =>
        methods.map((method) => ({ method, path: candidate })),
      );
      expect(probes.every((pair) => resolveRouteOwner(pair) === "hono")).toBe(true);
      // Enable the controls too so they require the reservation check.
      const manifest = probes
        .filter(({ method }) => method !== "HEAD")
        .map((pair) => ({ ...pair, enabled: true }));
      const releases = [{ method: registered, path }];
      const disabled = manifest.map((entry) => ({ ...entry, enabled: false }));
      for (const pair of probes) {
        expect(resolveRouteOwner(pair, manifest), routeKey(pair)).toBe("hono");
        const request = new Request(`https://example.test${pair.path}`, { method: pair.method });
        expect(decideOwner(request, manifest), routeKey(pair)).toBe("hono");
        expect(resolveRouteOwner(pair, disabled, releases), routeKey(pair)).toBe("hono");
        expect(resolveRouteOwner(pair, manifest, releases), routeKey(pair)).toBe(
          projectFixtureOwner(pair, selection, resolveRouteOwner),
        );
      }
      const projected = probes.filter(
        (pair) => projectFixtureOwner(pair, selection, resolveRouteOwner) === "kit",
      );
      expect(projected).toEqual(released.map((method) => ({ method, path })));
    },
  );

  it("requires a concrete API manifest entry and keeps adapter assets reserved", () => {
    const api = { method: "GET", path: "/api/public/events" };
    const pattern = { ...api, path: "/api/public/:key", enabled: true };
    const sibling = { ...api, path: "/api/public/community" };
    const manifest = [pattern, { ...api, enabled: true }, { ...sibling, enabled: true }];
    expect(resolveRouteOwner({ ...api, method: "head" }, manifest, [api])).toBe("kit");
    expect(resolveRouteOwner(sibling, manifest, [api])).toBe("hono");
    expect(resolveRouteOwner(api, [pattern], [api])).toBe("hono");
    expect(resolveRouteOwner(pattern, [pattern], [pattern])).toBe("hono");
    for (const path of [
      "/api/public/%65vents",
      "/api/public/events/__data.json",
      "/api/public/events/%5F%5Fdata.json",
    ]) {
      expect(resolveRouteOwner({ ...api, path }, manifest, [api]), path).toBe("hono");
    }
    for (const path of ["/_app", "/_app/immutable/example.js"]) {
      const asset = { method: "GET", path };
      expect(resolveRouteOwner(asset, [{ ...asset, enabled: true }], [asset]), path).toBe("hono");
    }
  });

  it("keeps registered 405s separate from wrong-method page 404s in the existing goldens", () => {
    const fallback = { method: "ALL", path: "/events/:key/rsvp" };
    expect(rows.find((row) => routeKey(row) === routeKey(fallback))).toMatchObject({
      kind: "method-fallback",
      hono405: true,
    });
    const enabled = new Set(families.flatMap(([family]) => [...familyEndpointKeys(rows, family)]));
    expect(enabled.has(routeKey(fallback))).toBe(false);
    const manifest = [
      ...rows
        .filter((row) => enabled.has(routeKey(row)))
        .map(({ method, path }) => ({ method, path, enabled: true })),
      ...ROUTE_MANIFEST,
    ];
    const refusal = explicitMethodRefusal({ allow: "PUT, DELETE", accept: null, vary: null });
    for (const [file, method, path, status] of [
      ["events_key_rsvp", "PATCH", fallback.path, refusal.status],
      ["about", "PUT", "/about", 404],
    ]) {
      const key = routeKey({ method, path });
      expect(enabled.has(key), key).toBe(false);
      const { request, response } = recording.get(`routes/${file}.json`)[method];
      expect(response.status, routeKey(request)).toBe(status);
      expect(resolveRouteOwner(request), routeKey(request)).toBe("hono");
      expect(resolveRouteOwner(request, manifest), routeKey(request)).toBe("hono");
    }
    const rsvp = recording.get("routes/events_key_rsvp.json");
    for (const method of ["PUT", "DELETE"]) {
      const { request } = rsvp[method];
      expect(resolveRouteOwner(request, manifest), routeKey(request)).toBe("kit");
    }
  });
});
