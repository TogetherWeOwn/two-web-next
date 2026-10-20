// route-inventory: PATCH /members/:user, POST /members/:user, POST /e/:key/rsvp
// Acceptance: over-cap 413 refusals give the member a way back to the form.
//
// Break this catches: `PayloadTooLargePage` offers only "Back to the homepage"
// with no testids (`src/error-pages.tsx`), so a member who pastes an oversized
// draft into the profile editor (POST/PATCH /members/:user, 64 KiB form cap)
// or an oversized RSVP note (POST /e/:key/rsvp, 4 KiB action cap) lands on a
// homepage dead end with no path back to the editor. The fix derives a return
// href from the request path: member-write surfaces return to their form,
// unknown and admin paths keep the homepage return.
//
// Contract (the Builder implements to these pins; never edit this file):
// - HTML 413 always carries `error-return` (form path, or `/` when unknown)
//   plus `error-home` (`/`), both as same-origin relative hrefs.
// - Mapping: POST|PATCH /members/:user -> /members/:user (exact id, query
//   dropped); POST /e/:key/rsvp -> /e/:key (suffix stripped, hostile query
//   never reflected); everything else (unknown, admin) -> `/`.
// - Copy keeps the "That request is too large" heading, states the refused
//   body was not saved, and never promises draft restore.
// - JSON 413 stays byte-stable (`payload_too_large` + message, no extra keys)
//   and the machine-only prefix rules (/api/*, JSON-only event writes) win
//   over an HTML Accept or a missing Accept exactly as today.
//
// Hermetic: `payloadTooLarge` fixtures at the real paths, the real
// `requestBodyLimit` middleware, and the mounted profiles app with in-memory
// fakes. No DATABASE_URL, no Discord, no network.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES, requestBodyLimit } from "../src/body-limit";
import type { Env } from "../src/env";
import { payloadTooLarge } from "../src/errors";
import { profilesApp } from "../src/profiles/routes";
import { createMemorySessionStore } from "../src/sessions";

const APP_URL = "https://fixture.example.test";
const env = { APP_URL, SESSION_SECRET: "test-session-secret-at-least-32-bytes-long" } as Env;
const USER_ID = "111111111111111111";
const EVENT_KEY = "GAME-NIGHT-01";
const MEMBER_PATH = `/members/${USER_ID}`;
const RSVP_POST_PATH = `/e/${EVENT_KEY}/rsvp`;
const RSVP_RETURN_PATH = `/e/${EVENT_KEY}`;
const JSON_413 = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const JSON_413_BYTES = JSON.stringify(JSON_413);

// The refused body is gone: honest copy says so and never promises a restore.
const HONEST_SAVED = /nothing was saved|not saved|could not be saved|not recoverable/i;
const RESTORE_PROMISES = [
  /restor\w+ your draft/i,
  /your draft (was|is|has been) (saved|kept|preserved)/i,
  /we (saved|kept|preserved) your (draft|changes)/i,
  /pick up where you left off/i,
  /no work was lost/i,
  /draft (saved|preserved|waiting for you)/i,
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("413 return fixtures must remain offline");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function hrefOf(html: string, testid: string): string | null {
  const tag = html.match(new RegExp(`<a[^>]*data-testid="${testid}"[^>]*>`, "i"));
  return tag?.[0].match(/href="([^"]*)"/i)?.[1] ?? null;
}

function linkTextOf(html: string, testid: string): string | null {
  const m = html.match(new RegExp(`<a[^>]*data-testid="${testid}"[^>]*>([^<]*)</a>`, "i"));
  return m?.[1]?.trim() ? m[1].trim() : null;
}

// A return href is always a same-origin relative path: no scheme, no
// protocol-relative `//`, no reflected query attacker bytes.
function assertSafeReturnHref(href: string | null, expected: string) {
  expect(href).toBe(expected);
  expect(href).toMatch(/^\/(?!\/)/);
  expect(href).not.toContain("://");
}

// Direct `payloadTooLarge` at the exact member-write, unknown and admin
// paths, so the mapping is pinned without session, store or throttle setup.
function mappingFixture() {
  const f = new Hono<{ Bindings: Env }>();
  f.post("/members/:user", (c) => payloadTooLarge(c));
  f.patch("/members/:user", (c) => payloadTooLarge(c));
  f.post("/e/:key/rsvp", (c) => payloadTooLarge(c));
  f.post("/some-future-widget", (c) => payloadTooLarge(c));
  f.post("/admin/queue/failed/:id/redispatch", (c) => payloadTooLarge(c));
  f.post("/api/upload", (c) => payloadTooLarge(c));
  f.post("/events", (c) => payloadTooLarge(c));
  f.patch("/events/:key", (c) => payloadTooLarge(c));
  f.post("/events/:key/publish", (c) => payloadTooLarge(c));
  f.put("/events/:key/rsvp", (c) => payloadTooLarge(c));
  f.delete("/events/:key/rsvp", (c) => payloadTooLarge(c));
  return f;
}

const HTML = { headers: { accept: "text/html" } };

async function htmlFor(method: string, path: string): Promise<{ status: number; html: string }> {
  const response = await mappingFixture().request(path, { method, ...HTML }, env);
  return { status: response.status, html: await response.text() };
}

describe("HTML 413 returns member-write surfaces to their form", () => {
  it.each(["POST", "PATCH"])("%s /members/:user returns to the profile editor", async (method) => {
    const { status, html } = await htmlFor(method, MEMBER_PATH);
    expect(status).toBe(413);
    assertSafeReturnHref(hrefOf(html, "error-return"), MEMBER_PATH);
    expect(linkTextOf(html, "error-return")).toBeTruthy();
  });

  it("POST /e/:key/rsvp returns to the event page", async () => {
    const { status, html } = await htmlFor("POST", RSVP_POST_PATH);
    expect(status).toBe(413);
    assertSafeReturnHref(hrefOf(html, "error-return"), RSVP_RETURN_PATH);
    expect(linkTextOf(html, "error-return")).toBeTruthy();
  });

  it("unknown paths keep the homepage return", async () => {
    const { status, html } = await htmlFor("POST", "/some-future-widget");
    expect(status).toBe(413);
    assertSafeReturnHref(hrefOf(html, "error-return"), "/");
  });

  it("admin paths keep the homepage return (no admin-surface return)", async () => {
    const { status, html } = await htmlFor("POST", "/admin/queue/failed/1/redispatch");
    expect(status).toBe(413);
    assertSafeReturnHref(hrefOf(html, "error-return"), "/");
  });

  it.each([
    ["POST", MEMBER_PATH],
    ["PATCH", MEMBER_PATH],
    ["POST", RSVP_POST_PATH],
    ["POST", "/some-future-widget"],
  ])("%s %s keeps the home action", async (method, path) => {
    const { html } = await htmlFor(method, path);
    expect(hrefOf(html, "error-home")).toBe("/");
    expect(linkTextOf(html, "error-home")).toBeTruthy();
  });

  it("profile return drops the query instead of reflecting it", async () => {
    const { html } = await htmlFor("POST", `${MEMBER_PATH}?next=https://evil.test&x=%3Cscript%3E`);
    assertSafeReturnHref(hrefOf(html, "error-return"), MEMBER_PATH);
    const href = hrefOf(html, "error-return")!;
    expect(href).not.toContain("evil");
    expect(href).not.toContain("next");
    expect(href).not.toContain("script");
  });

  it("RSVP return never reflects hostile query bytes", async () => {
    const { html } = await htmlFor("POST", `${RSVP_POST_PATH}?attendees=2&next=https://evil.test`);
    const href = hrefOf(html, "error-return");
    // The attendee page may be preserved, but nothing hostile may be echoed.
    expect(href === RSVP_RETURN_PATH || href === `${RSVP_RETURN_PATH}?attendees=2`).toBe(true);
    expect(href).not.toContain("evil");
    expect(href).not.toContain("next");
    expect(href).not.toContain("http");
  });
});

describe("HTML 413 copy stays honest about the refused body", () => {
  it.each([
    ["POST", MEMBER_PATH],
    ["POST", RSVP_POST_PATH],
    ["POST", "/some-future-widget"],
  ])("%s %s says the body was not saved", async (method, path) => {
    const { html } = await htmlFor(method, path);
    expect(html).toContain("That request is too large");
    expect(html).toMatch(HONEST_SAVED);
  });

  it.each([
    ["POST", MEMBER_PATH],
    ["POST", RSVP_POST_PATH],
    ["POST", "/some-future-widget"],
  ])("%s %s never promises draft restore", async (method, path) => {
    const { html } = await htmlFor(method, path);
    for (const promise of RESTORE_PROMISES) expect(html).not.toMatch(promise);
  });
});

describe("over-cap member writes refuse through the real limiter with the return", () => {
  function profile() {
    const sessions = createMemorySessionStore();
    return profilesApp({
      sessionStore: sessions,
      throttle: async () => ({ limited: false }) as const,
      store: {
        find: async () => null,
        save: async () => {},
      },
    });
  }

  function rsvpAdapter() {
    const f = new Hono<{ Bindings: Env }>();
    f.post("/e/:key/rsvp", requestBodyLimit("action"), (c) => c.text("unreached"));
    return f;
  }

  it.each([
    ["POST", "application/x-www-form-urlencoded", BODY_LIMIT_BYTES.form],
    ["PATCH", "application/json", BODY_LIMIT_BYTES.form],
  ])(
    "real %s /members/:user over-cap is 413 HTML returning to the editor",
    async (method, contentType, cap) => {
      const response = await profile().request(
        MEMBER_PATH,
        {
          method,
          body: "x".repeat(cap + 1),
          headers: {
            origin: APP_URL,
            accept: "text/html",
            "content-type": contentType,
          },
        },
        env,
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("vary")).toContain("Accept");
      const html = await response.text();
      expect(html).toContain("That request is too large");
      assertSafeReturnHref(hrefOf(html, "error-return"), MEMBER_PATH);
      expect(hrefOf(html, "error-home")).toBe("/");
      expect(html).toMatch(HONEST_SAVED);
    },
  );

  it("real POST /e/:key/rsvp over-cap is 413 HTML returning to the event", async () => {
    const response = await rsvpAdapter().request(
      RSVP_POST_PATH,
      {
        method: "POST",
        body: "x".repeat(BODY_LIMIT_BYTES.action + 1),
        headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );
    expect(response.status).toBe(413);
    const html = await response.text();
    assertSafeReturnHref(hrefOf(html, "error-return"), RSVP_RETURN_PATH);
    expect(hrefOf(html, "error-home")).toBe("/");
  });
});

describe("JSON 413 contract stays byte-stable on every pinned surface", () => {
  it.each([
    ["POST", MEMBER_PATH],
    ["PATCH", MEMBER_PATH],
    ["POST", RSVP_POST_PATH],
  ])("%s %s with a JSON Accept keeps the exact envelope", async (method, path) => {
    const response = await mappingFixture().request(
      path,
      { method, headers: { accept: "application/json" } },
      env,
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toContain("Accept");
    expect(await response.json()).toEqual(JSON_413);
  });

  it.each([
    ["POST", "/api/upload"],
    ["POST", "/events"],
    ["PATCH", "/events/abc"],
    ["POST", "/events/abc/publish"],
    ["PUT", "/events/abc/rsvp"],
    ["DELETE", "/events/abc/rsvp"],
  ])(
    "machine-only %s %s stays JSON under HTML, wildcard and missing Accept",
    async (method, path) => {
      for (const accept of ["text/html", "*/*", ""]) {
        const init: RequestInit & { method: string } = accept
          ? { method, headers: { accept } }
          : { method };
        const response = await mappingFixture().request(path, init, env);
        expect(response.status, `accept=${accept || "(missing)"}`).toBe(413);
        expect(await response.json(), `accept=${accept || "(missing)"}`).toEqual(JSON_413);
      }
    },
  );

  it("canonical JSON body is byte-identical", async () => {
    const response = await mappingFixture().request(
      MEMBER_PATH,
      { method: "POST", headers: { accept: "application/json" } },
      env,
    );
    expect(await response.text()).toBe(JSON_413_BYTES);
  });

  it("control: real POST /members/:user over-cap with JSON Accept keeps the envelope", async () => {
    const sessions = createMemorySessionStore();
    const profile = profilesApp({
      sessionStore: sessions,
      throttle: async () => ({ limited: false }) as const,
      store: {
        find: async () => null,
        save: async () => {},
      },
    });
    const response = await profile.request(
      MEMBER_PATH,
      {
        method: "POST",
        body: "x".repeat(BODY_LIMIT_BYTES.form + 1),
        headers: {
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
      },
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(JSON_413);
  });
});
