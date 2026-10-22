// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key
// route-inventory: POST /admin/events/:key/publish
// route-inventory: POST /admin/featured
// Acceptance: a throttled moderator write gets a way back to the form.
//
// All admin writes share the 30/min `admin-write` bucket; today a refused
// moderator POST renders the generic 429 page (invite + home only) while
// `private, no-store` kills back-button draft recovery. The Kit error shell
// shares the dead end. The refused POST must instead offer an admin way-back
// link (pinned `error-admin-back` testid) to the form it came from, keep the
// invite/home recovery, and state honestly that the submission was not saved.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass. Owned path: this
// file only — the Builder builds on this branch and never edits this file.
//
// Hermetic: main app with in-memory sessions, a counting throttle Sql double
// pre-filled to the spent budget, store spies and a fail-if-touched Db
// double; no DATABASE_URL, no sockets.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEvent,
  createFeatured,
  getEvent,
  setRsvpOpen,
  transitionEvent,
  updateEvent,
} from "../src/admin/store";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import app from "./app";
import { cookieFor, env, EVENT_KEY, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  createFeatured: vi.fn(),
  transitionEvent: vi.fn(),
  setRsvpOpen: vi.fn(),
}));

/** The one pinned way-back testid both twins render. */
const WAYBACK_TESTID = "error-admin-back";

/** Copy that would lie about the refused body. None of it may appear on a 429. */
const RECOVERABILITY_PHRASES = [
  "you can resume",
  "nothing was lost",
  "no data was lost",
  "your input was preserved",
  "your draft was preserved",
  "will be restored",
  "has been saved",
  "recover your draft",
  "back button",
];

const INVITE = "https://discord.gg/invite";

// Any property access is a store read/write the fixture must never perform
// (the throttle refuses before the handler, so no handler store seam runs).
const dbTouched = vi.fn(() => {
  throw new Error("fixture must not query a DB");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;

function throttleFixture(initial: number) {
  let hits = initial;
  const sql = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const store = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
  return { sql, store, count: () => hits };
}

type Throttle = ReturnType<typeof throttleFixture>;

async function spentBindings(throttle: Throttle) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MODERATOR);
  return {
    cookie,
    bindings: {
      ...env,
      ADMIN_DB: db,
      SESSION_STORE: sessions,
      THROTTLE_STORE: throttle.store,
    } as unknown as EnvWithThrottle,
  };
}

function postHtml(cookie: string, body: string) {
  return {
    method: "POST" as const,
    headers: {
      cookie,
      origin: env.APP_URL,
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  };
}

/** Asserts the way-back anchor carries the pinned testid and the form href. */
function expectWayback(html: string, href: string) {
  expect(html).toContain(`data-testid="${WAYBACK_TESTID}"`);
  const anchor = new RegExp(`<a\\b[^>]*data-testid="${WAYBACK_TESTID}"[^>]*>`).exec(html);
  expect(anchor?.[0], "way-back anchor is present").toBeDefined();
  expect(anchor![0]).toContain(`href="${href}"`);
}

function expectNoRecoverabilityLie(html: string) {
  const lower = html.toLowerCase();
  for (const phrase of RECOVERABILITY_PHRASES) {
    expect(lower, `must not claim "${phrase}"`).not.toContain(phrase);
  }
}

function expectNoStoreWork(throttle: Throttle) {
  expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
  expect(createEvent).not.toHaveBeenCalled();
  expect(getEvent).not.toHaveBeenCalled();
  expect(updateEvent).not.toHaveBeenCalled();
  expect(createFeatured).not.toHaveBeenCalled();
  expect(transitionEvent).not.toHaveBeenCalled();
  expect(setRsvpOpen).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
}

const FORM_BODY = new URLSearchParams({ title: "Game night" }).toString();

const WAYBACK_CASES = [
  ["event create", "/admin/events", "/admin/events/new", FORM_BODY],
  ["event update", `/admin/events/${EVENT_KEY}`, `/admin/events/${EVENT_KEY}`, FORM_BODY],
  ["lifecycle publish", `/admin/events/${EVENT_KEY}/publish`, `/admin/events/${EVENT_KEY}`, ""],
  ["featured create", "/admin/featured", "/admin/featured/new", FORM_BODY],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin-path 429 shows the admin way back (Hono)", () => {
  it.each(WAYBACK_CASES)(
    "%s: throttled moderator POST %s renders the way-back link to %s and keeps invite/home",
    async (_label, path, href, body) => {
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const { cookie, bindings } = await spentBindings(throttle);
      const response = await app.request(path, postHtml(cookie, body), bindings);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("vary")).toContain("Accept");
      const html = await response.text();
      expect(html).toContain("Slow down a little");
      expectWayback(html, href);
      expect(html).toContain('data-testid="error-invite"');
      expect(html).toContain(`href="${INVITE}"`);
      expect(html).toContain('data-testid="error-home"');
      expectNoStoreWork(throttle);
    },
  );

  it("non-admin 429 carries no admin way back", async () => {
    const { rateLimitExceeded } = await import("../src/errors");
    const fixture = new Hono();
    fixture.get("/429", (c) => rateLimitExceeded(c));
    const response = await fixture.request("/429", {}, env);
    expect(response.status).toBe(429);
    const html = await response.text();
    expect(html).toContain('data-testid="error-invite"');
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain(WAYBACK_TESTID);
  });

  it("admin 429 JSON envelope is byte-stable with no admin keys", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const { cookie, bindings } = await spentBindings(throttle);
    const response = await app.request(
      "/admin/events",
      {
        ...postHtml(cookie, FORM_BODY),
        headers: { ...postHtml(cookie, FORM_BODY).headers, accept: "application/json" },
      },
      bindings,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "reason", "request_id", "retry_after"]);
    expect(body).toMatchObject({
      reason: "rate_limited",
      message: "Too many requests. Try again in 30 seconds.",
      retry_after: 30,
    });
    expectNoStoreWork(throttle);
  });

  it("bare JSON envelope keeps its exact bytes", async () => {
    const { rateLimitExceeded } = await import("../src/errors");
    const fixture = new Hono();
    fixture.get("/limited", (c) => rateLimitExceeded(c, 30));
    const response = await fixture.request(
      "/limited",
      { headers: { accept: "application/json" } },
      env,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      code: "rate_limited",
      reason: "rate_limited",
      message: "Too many requests. Try again in 30 seconds.",
      retry_after: 30,
      next: "Wait for Retry-After, then retry.",
    });
  });
});

describe("draft-loss honesty", () => {
  it("throttled admin write states the submission was not saved, never that it is recoverable", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const { cookie, bindings } = await spentBindings(throttle);
    const response = await app.request("/admin/events", postHtml(cookie, FORM_BODY), bindings);
    expect(response.status).toBe(429);
    const html = await response.text();
    expect(html).toMatch(/not saved/i);
    expectNoRecoverabilityLie(html);
  });
});

describe("404/410/403/413 shells untouched", () => {
  it("forbidden keeps its shell with no admin way back", async () => {
    const { forbidden } = await import("../src/errors");
    const fixture = new Hono();
    fixture.get("/forbidden", (c) => forbidden(c));
    const response = await fixture.request("/forbidden", {}, env);
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("You do not have access");
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain(WAYBACK_TESTID);
  });

  it("not-found keeps its shell with no admin way back", async () => {
    const { notFoundHandler } = await import("../src/errors");
    const fixture = new Hono();
    fixture.notFound(notFoundHandler);
    const response = await fixture.request("/definitely-not-here", {}, env);
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("We cannot find that page");
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain(WAYBACK_TESTID);
  });

  it("gone keeps its shell with no admin way back", async () => {
    const { gone } = await import("../src/errors");
    const fixture = new Hono();
    fixture.get("/gone", (c) => gone(c));
    const response = await fixture.request("/gone", {}, env);
    expect(response.status).toBe(410);
    const html = await response.text();
    expect(html).toContain("This page is gone");
    expect(html).toContain('data-testid="error-home"');
    expect(html).not.toContain(WAYBACK_TESTID);
  });

  it("payload-too-large keeps its shell with no admin way back", async () => {
    const { payloadTooLarge } = await import("../src/errors");
    const fixture = new Hono();
    fixture.post("/upload", (c) => payloadTooLarge(c));
    const response = await fixture.request("/upload", { method: "POST" }, env);
    expect(response.status).toBe(413);
    const html = await response.text();
    expect(html).toContain("That request is too large");
    expect(html).not.toContain(WAYBACK_TESTID);
  });
});

describe("Kit 429 twin parity", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  it("ErrorShell renders the same way-back testid for an admin 429", () => {
    const shell = read("web/src/lib/ErrorShell.svelte");
    expect(shell).toContain(WAYBACK_TESTID);
    expect(shell).toContain("adminBack");
    expect(shell).toMatch(/\{#if[^}]*adminBack/);
  });

  it("+error wires the admin way back into the shell", () => {
    const page = read("web/src/routes/+error.svelte");
    expect(page).toContain("adminBack");
    expect(page).toMatch(/page\.url|page\.route/);
    expect(page).toContain("/admin");
    expect(page).toMatch(/adminBack\s*=\s*\{/);
  });

  it("Hono and Kit pin the identical way-back testid", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const { cookie, bindings } = await spentBindings(throttle);
    const response = await app.request("/admin/events", postHtml(cookie, FORM_BODY), bindings);
    expect(response.status).toBe(429);
    const html = await response.text();
    expect(html).toContain(`data-testid="${WAYBACK_TESTID}"`);
    expect(read("web/src/lib/ErrorShell.svelte")).toContain(`data-testid="${WAYBACK_TESTID}"`);
  });
});
