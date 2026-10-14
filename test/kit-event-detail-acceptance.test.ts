// Acceptance coverage for the staged Kit read model for GET /e/:key (PR #849).
//
// Test-Author card: test files only, no source changes. Each "staged" block
// fails on main (staged files + disabled manifest entry are absent) and passes
// once the Land card lands the PR branch. Each "served stability" block passes
// both before and after: the Hono handler keeps answering while the manifest
// entry stays disabled, so landing must not change live traffic.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_MANIFEST, resolveRouteOwner } from "../src/route-ownership";

const ROOT = join(__dirname, "..");
const RESOLVER = join(ROOT, "src/events/kit-detail.ts");
const VIEW = join(ROOT, "web/src/lib/EventDetail.svelte");
const PAGE_SERVER = join(ROOT, "web/src/routes/e/[key]/+page.server.ts");
const PAGE = join(ROOT, "web/src/routes/e/[key]/+page.svelte");
const PR_TEST = join(ROOT, "test/kit-event-detail.test.ts");
const PR_STORE_TEST = join(ROOT, "test/kit-event-detail-store.test.ts");
const PARITY_DOC = join(ROOT, "docs/kit-parity-gates.md");

function readOrFail(path: string): string {
  expect(existsSync(path), `staged file is missing: ${path}`).toBe(true);
  return readFileSync(path, "utf8");
}

function containsAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

describe("acceptance: staged GET /e/:key manifest entry", () => {
  it("ships a disabled member-read entry so Hono keeps serving", () => {
    const entry = ROUTE_MANIFEST.find(
      (candidate) => candidate.method === "GET" && candidate.path === "/e/:key",
    );
    expect(entry, "ROUTE_MANIFEST has no GET /e/:key entry").toBeDefined();
    expect(entry?.enabled).toBe(false);
    expect(entry?.reads).not.toBe("public");
  });

  it("keeps resolving the live detail path to Hono while disabled", () => {
    const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(resolveRouteOwner({ method: "GET", path: `/e/${key}` })).toBe("hono");
    expect(resolveRouteOwner({ method: "HEAD", path: `/e/${key}` })).toBe("hono");
  });

  it("leaves JSON and ICS Hono-owned with no manifest entries of their own", () => {
    const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(
      ROUTE_MANIFEST.some((entry) => entry.path === "/events/:key" || entry.path.endsWith(".ics")),
    ).toBe(false);
    expect(resolveRouteOwner({ method: "GET", path: `/events/${key}` })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: `/events/${key}.ics` })).toBe("hono");
  });
});

describe("acceptance: staged resolver gate order", () => {
  it("stages the framework-free resolver file", () => {
    expect(existsSync(RESOLVER), "src/events/kit-detail.ts is missing").toBe(true);
  });

  it("mirrors the served gate order: canonical, admission, cancelled, outage, draft", () => {
    const source = readOrFail(RESOLVER).toLowerCase();
    for (const token of ["canonical", "cancelled", "410", "draft", "403", "503"]) {
      expect(source, `resolver never mentions ${token}`).toContain(token);
    }
    expect(source, "resolver never admits keys").toMatch(/admission|allowed|ulid|forged/);
  });

  it("declares audited member-read subjects and fails closed before bytes", () => {
    const source = readOrFail(RESOLVER).toLowerCase();
    expect(source, "resolver never declares an audit subject").toMatch(/audit|subject/);
    expect(source, "resolver never maps an outage to 503").toContain("503");
  });
});

describe("acceptance: staged member-only attendee privacy", () => {
  it("keeps attendee/answer/waitlist reads behind the member boundary", () => {
    const source = readOrFail(RESOLVER).toLowerCase();
    expect(source, "resolver never mentions attendee reads").toMatch(/attendee/);
    expect(
      containsAny(source, [/answer/, /waitlist/]),
      "resolver mentions neither answers nor waitlists",
    ).toBe(true);
    expect(source, "resolver never distinguishes member from guest/anonymous").toMatch(
      /member|guest|anonymous/,
    );
  });

  it("pins private no-store and cookie variance for member responses", () => {
    const source = readOrFail(RESOLVER).toLowerCase();
    expect(source, "resolver never sets private no-store").toMatch(/no-store/);
    expect(source, "resolver never varies on cookie").toMatch(/vary/);
  });
});

describe("acceptance: staged view contract", () => {
  it("stages the Kit view and thin route files", () => {
    for (const path of [VIEW, PAGE_SERVER, PAGE]) {
      expect(existsSync(path), `staged Kit file is missing: ${path}`).toBe(true);
    }
  });

  it("keeps a native no-JS RSVP form posting to the unchanged Hono controller", () => {
    const source = readOrFail(VIEW).toLowerCase();
    expect(source, "view has no native form").toContain("<form");
    expect(source, "view RSVP form is not a native POST").toMatch(/method=.?post/);
  });

  it("splits the share fallback from body copy and keeps discovery metadata", () => {
    const source = readOrFail(VIEW).toLowerCase();
    expect(source, "view never renders a share fallback").toMatch(/share/);
    expect(
      containsAny(source, [/discover/, /datetime/, /ics/, /return/]),
      "view carries no discovery/ICS/return affordance",
    ).toBe(true);
  });
});

describe("acceptance: staged route binding", () => {
  it("maps non-ok resolver outcomes onto redirect/error without owning JSON/ICS", () => {
    const source = readOrFail(PAGE_SERVER).toLowerCase();
    expect(source, "route load never redirects").toMatch(/redirect/);
    expect(source, "route load never raises typed errors").toMatch(/error/);
    expect(source, "route must not own JSON/ICS siblings").not.toMatch(/\.ics|json/);
  });
});

describe("acceptance: PR regression tests land with the slice", () => {
  it("brings the resolver regression suite", () => {
    expect(existsSync(PR_TEST), "test/kit-event-detail.test.ts is missing").toBe(true);
    const source = readFileSync(PR_TEST, "utf8");
    expect(source.length).toBeGreaterThan(4000);
  });

  it("brings the store/outage regression suite", () => {
    expect(existsSync(PR_STORE_TEST), "test/kit-event-detail-store.test.ts is missing").toBe(true);
  });

  it("records the staged route in the parity inventory", () => {
    const doc = readOrFail(PARITY_DOC);
    expect(doc, "parity doc never inventories /e/:key").toMatch(/\/e\/:key/);
  });
});
