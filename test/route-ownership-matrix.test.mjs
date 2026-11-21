import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explicitMethodRefusal } from "../src/http/method";
import { resolveRouteOwner } from "../src/route-ownership";
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
  ["ops", 18],
  ["assets", 0],
  ["feeds", 5],
  ["public-api", 5],
  ["admin", 20],
  ["auth", 9],
  ["event-writes", 10],
  ["member-writes", 4],
  ["machine", 3],
];

function goldenStatus(file, vector) {
  return recording.get(`routes/${file}.json`)[vector].response.status;
}

describe("route ownership preparation matrix (not runtime dispatch)", () => {
  it.each(families)("selects only %s endpoint registration pairs", (family, count) => {
    const selection = familyEndpointKeys(rows, family);
    expect(selection.size).toBe(count);
    const changed = rows.filter(
      (row) => projectFixtureOwner(row, selection, () => "hono") === "kit",
    );
    expect(changed).toEqual(rows.filter((row) => row.family === family && row.kind === "endpoint"));
    for (const key of selection) expect(registrationKeys.has(key), key).toBe(true);
  });

  it("accounts for separately classified endpoints, method fallbacks, middleware and assets", () => {
    const counts = Object.fromEntries(families);
    const tagged = rows.filter((row) => row.kind === "endpoint" && row.family !== null);
    expect(tagged).toHaveLength(74);
    for (const row of tagged) {
      expect(Object.hasOwn(counts, row.family), routeKey(row)).toBe(true);
      expect(methods).toContain(row.method);
    }
    expect(rows.filter((row) => row.kind === "method-fallback")).toHaveLength(11);
    expect(rows.filter((row) => row.kind === "middleware")).toHaveLength(6);
    const assets = [...recording].filter(([file]) => file.startsWith("static/"));
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.map(([, vectors]) => `STATIC ${routeKey(vectors.GET.request)}`).sort()).toEqual(
      coverage
        .filter(({ entry }) => entry.startsWith("STATIC "))
        .map(({ entry }) => entry)
        .sort(),
    );
  });

  it("keeps current manifest decisions for the recorded requests with every new family off", () => {
    const off = new Set();
    for (const vectors of recording.values()) {
      for (const { request } of Object.values(vectors)) {
        expect(projectFixtureOwner(request, off, resolveRouteOwner), routeKey(request)).toBe(
          resolveRouteOwner(request),
        );
      }
    }
  });

  it.each([
    ["event-writes", "/events"],
    ["admin", "/admin/events"],
  ])("selects the %s POST without changing same-path GET or HEAD", (family, path) => {
    const selection = familyEndpointKeys(rows, family);
    const write = { method: "POST", path };
    expect(resolveRouteOwner(write)).toBe("hono");
    expect(projectFixtureOwner(write, selection, resolveRouteOwner)).toBe("kit");
    for (const method of ["GET", "HEAD"]) {
      const read = { method, path };
      expect(selection.has(routeKey(read))).toBe(false);
      expect(projectFixtureOwner(read, selection, resolveRouteOwner)).toBe(resolveRouteOwner(read));
    }
  });

  it.each([
    ["/up", "/version", ["GET", "HEAD"], "GET"],
    ["/csp-reports", "/version", ["POST"], "POST"],
  ])("projects an exact reserved release for %s only", (path, sibling, released, registered) => {
    expect(familyEndpointKeys(rows, "ops").has(routeKey({ method: registered, path }))).toBe(true);
    const selection = new Set(released.map((method) => routeKey({ method, path })));
    const probes = [path, sibling, `${path}/`].flatMap((candidate) =>
      methods.map((method) => ({ method, path: candidate })),
    );
    expect(probes.every((pair) => resolveRouteOwner(pair) === "hono")).toBe(true);
    const projected = probes.filter(
      (pair) => projectFixtureOwner(pair, selection, resolveRouteOwner) === "kit",
    );
    expect(projected).toEqual(released.map((method) => ({ method, path })));
  });

  it("keeps registered 405s separate from wrong-method page 404s in the existing goldens", () => {
    const fallback = { method: "ALL", path: "/events/:key/rsvp" };
    expect(rows.find((row) => routeKey(row) === routeKey(fallback))).toMatchObject({
      kind: "method-fallback",
      hono405: true,
    });
    const selection = familyEndpointKeys(rows, "event-writes");
    expect(selection.has(routeKey(fallback))).toBe(false);
    expect(selection.has(routeKey({ ...fallback, method: "PATCH" }))).toBe(false);
    const refusal = explicitMethodRefusal({ allow: "PUT, DELETE", accept: null, vary: null });
    expect(goldenStatus("events_key_rsvp", "PATCH")).toBe(refusal.status);
    expect(goldenStatus("about", "PUT")).toBe(404);
  });
});
