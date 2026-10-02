import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { internalErrorHandler, maintenanceHandler, rateLimitExceeded } from "../src/errors";
import { concretePath, EVENT_KEY, HTML_READS, NON_HTML_READS, pageShellFixture } from "./helpers/page-shells";

function assertShell(html: string) {
  expect(html.match(/<main\b[^>]*>/g)).toHaveLength(1);
  expect(html.match(/\bid="main"/g)).toHaveLength(1);
  expect(html).toMatch(/<main id="main" tabindex="-1">/);
  expect(html.match(/<a\b[^>]*href="#main"[^>]*>/g)).toHaveLength(1);
  // First child of body is stronger than first anchor: no button/input/positive
  // tabindex can silently get ahead of the bypass link.
  expect(html).toMatch(/<body(?: class="base-theme (?:homepage|content|join|profile)-theme")?>\s*<a class="skip-link" href="#main">Skip to content<\/a>/);
  for (const nav of html.match(/<nav\b[^>]*>/g) ?? []) expect(nav).toMatch(/aria-label="[^"]+"/);
  expect(html).toContain('rel="stylesheet" href="/styles.css"');
}

function assertInventory(router: { routes: { method: string; path: string }[] }) {
  const actual = router.routes.filter((route) => route.method === "GET").map((route) => route.path).sort();
  // The event read boundary encloses its existing GET registration.
  expect(actual).toEqual([...HTML_READS, ...NON_HTML_READS].sort());
}

beforeEach(() => {
  // Even a swallowed fetch error is a test failure: nothing reaches Discord,
  // a preview service or a staging/production database in this suite.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("page-shell tests must remain local"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("classifies every mounted GET route, so new HTML pages cannot escape coverage", () => {
  assertInventory(app);
  const changed = new Hono().route("/", app);
  changed.get("/new-page", (c) => c.html("uncovered"));
  expect(() => assertInventory(changed)).toThrow();
});

describe("every GET HTML route uses an accessible page shell (local fixtures)", () => {
  it.each(HTML_READS)("%s: one first-tab skip link, one focusable main, labelled navs", async (pattern) => {
    const response = await pageShellFixture().request(concretePath(pattern));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    assertShell(await response.text());
  });
});

it("serves a recovery HTML shell and bool-only status to guests without a session", async () => {
  const { env } = pageShellFixture();
  const recovery = await app.request(new URL("/auth/recover?next=%2Fprofile", env.APP_URL).toString(), {}, env);
  expect(recovery.status).toBe(200);
  expect(recovery.headers.get("content-type")).toContain("text/html");
  const html = await recovery.text();
  assertShell(html);
  expect(html).toContain("Your earlier changes were not saved");
  expect(html).toContain('href="/auth/discord?next=%2Fprofile"');
  const status = await app.request(new URL("/auth/status", env.APP_URL).toString(), {}, env);
  expect(status.status).toBe(200);
  expect(status.headers.get("content-type")).toContain("application/json");
  expect(await status.json()).toEqual({ authenticated: false });
});

it("renders the join-attempt fixture through the mounted detail route", async () => {
  const fixture = pageShellFixture();
  const list = await fixture.request("/admin/join-attempts");
  expect(list.status).toBe(200);
  expect(await list.text()).toContain('href="/admin/join-attempts/1"');
  const response = await fixture.request("/admin/join-attempts/1");
  expect(response.status).toBe(200);
  const html = await response.text();
  assertShell(html);
  expect(html).toContain("Join attempt 1");
  expect(html).toContain("page-shell-join-request");
  expect(html).toContain('href="/admin/join-attempts"');
  expect(html).toContain('datetime="2030-01-01T20:00:00.000Z"');
});

it.each([
  ["/join/callback?error=access_denied", 200],
  ["/e/missing-event", 404],
  ["/admin/events/missing-event", 404],
  ["/admin/featured/999", 404],
  ["/admin/join-attempts/999", 404],
  ["/admin/join-attempts/not-an-id", 404],
  ["/members/100000000000000002", 404],
  ["/missing-page", 404],
  [`/e/${EVENT_KEY}`, 410],
] as const)("%s (%i) preserves the shell on recovery/error variants", async (path, status) => {
  const response = await pageShellFixture(status === 410 ? "cancelled" : "published").request(path);
  expect(response.status).toBe(status);
  assertShell(await response.text());
});

it.each([429, 500, 503])("branded %i pages preserve the same bypass and landmarks", async (status) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors = new Hono();
  errors.get("/", (c) => status === 429 ? rateLimitExceeded(c)
    : status === 503 ? maintenanceHandler("https://discord.gg/fixture")(c)
    : internalErrorHandler(new Error("fixture failure"), c));
  const response = await errors.request("/");
  expect(response.status).toBe(status);
  assertShell(await response.text());
});

it("keeps bypass visibility and keyboard focus styling in external CSS", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY\(calc\(-100%/);
  expect(css).toMatch(/\.skip-link:focus\s*\{[^}]*transform:\s*none/);
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*3px/);
});
