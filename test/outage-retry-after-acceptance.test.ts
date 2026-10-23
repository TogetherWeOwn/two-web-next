// Test Author owned: Retry-After on Hono outage 503s (failing-first acceptance).
// The paired build branches from this file's commit and must turn every
// FAIL_TO_PASS test green WITHOUT editing this file.
//
// CONTRACT (the build implements exactly this):
// - `OUTAGE_RETRY_AFTER_SECONDS = 60`, exported from the errors barrel
//   (`src/errors`), is the single default every Hono outage 503 emits as its
//   `Retry-After` header.
// - The outage constructors clamp an optional retry-after input exactly like
//   the 429 path (floor, non-finite falls back to the constant, minimum 1):
//     databaseUnavailable(c, jsonOnly?, retryAfter?)
//     databaseUnavailableBuffered(c, retryAfter?)
//     eventsUnavailable(c, retryAfter?)
//     maintenanceHandler(inviteUrl, retryAfter?)
//   Appended optional parameters keep every existing caller working.
// - Bodies, statuses, cache-control/no-store, Vary: Accept and request_id
//   behavior are byte-identical apart from the added header. No `retry_after`
//   body field is added anywhere: headers only.
// - One stable contract row naming 503 + Retry-After + 60 lands in the runbook
//   or a sibling contract doc (see CONTRACT_DOCS below).
//
// AUDIT SCOPE (Hono only; Kit outage headers are a separate surface):
// In scope: databaseUnavailable (HTML + JSON twins, jsonOnly leg),
//   databaseUnavailableBuffered (HTML + JSON twins), eventsUnavailable (plain
//   text, island fragments + feeds), maintenanceHandler (same-file sibling),
//   and the inline `{error: "db_unavailable"}` JSON 503 legs on the event
//   routes (same error code, same missing-database cause).
// Audited and deliberately OUT (no Retry-After assertion here; the build MAY
// extend there without breaking this file because absence is never asserted):
//   readiness (/up), member-read contract refusals (the shared refusal text
//   also covers programming errors), save-recovery envelopes, auth, logout,
//   admin and ops JSON/text 503s, the agent-event ingress (own retry
//   vocabulary), Markdown/ai-friendly and feed range-error 503s (specialized
//   envelopes or deterministic faults), and provider-throttle recoveries
//   (already carry the provider backoff).
// Review verifies the single-sourcing (every default flows from the one named
// constant); these tests verify the exported value, the emitted headers, the
// clamp edges and the otherwise-identical bytes.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  databaseUnavailable,
  databaseUnavailableBuffered,
  internalErrorHandler,
  maintenanceHandler,
  rateLimitExceeded,
} from "../src/errors";
import { eventsUnavailable } from "../src/events/routes-shared";
import { requestLog } from "../src/request-log";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, env, EVENT_KEY, MODERATOR } from "./helpers/member-data";

// Contract casts: the build appends the optional retryAfter parameter to each
// constructor. The casts keep typecheck green on the RED baseline and stay
// valid once the parameters exist.
type NextDatabaseUnavailable = (
  c: Context,
  jsonOnly?: boolean,
  retryAfter?: number,
) => Response | Promise<Response>;
type NextBufferedUnavailable = (c: Context, retryAfter?: number) => Response | Promise<Response>;
type NextEventsUnavailable = (c: Context, retryAfter?: number) => Response;
type NextMaintenanceHandler = (
  inviteUrl: string,
  retryAfter?: number,
) => (c: Context) => Response | Promise<Response>;
const dbUnavailableNext = databaseUnavailable as unknown as NextDatabaseUnavailable;
const dbUnavailableBufferedNext = databaseUnavailableBuffered as unknown as NextBufferedUnavailable;
const eventsUnavailableNext = eventsUnavailable as unknown as NextEventsUnavailable;
const maintenanceHandlerNext = maintenanceHandler as unknown as NextMaintenanceHandler;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_ID = "0123456789abcdef-LHR";
const INVITE = "https://discord.gg/fixture-invite";
const BINDINGS: Env = {
  ...env,
  APP_URL: "https://outage.example.test",
  DISCORD_INVITE_URL: INVITE,
};

// The 429 clamp precedent, asserted through each outage constructor.
const CLAMP_CASES = [
  { retryAfter: 0, expected: "1" },
  { retryAfter: -5, expected: "1" },
  { retryAfter: 0.5, expected: "1" },
  { retryAfter: Number.NaN, expected: "60" },
  { retryAfter: Number.POSITIVE_INFINITY, expected: "60" },
  { retryAfter: 1.9, expected: "1" },
  { retryAfter: 30, expected: "30" },
];

// Literal, never computed by the response helper under test.
const OUTAGE_JSON_BODY = {
  error: "db_unavailable",
  message: "The service is temporarily unavailable. Try again shortly.",
  request_id: REQUEST_ID,
};
const INLINE_JSON_BODY = { error: "db_unavailable" };
const EVENTS_TEXT_BODY = "Events temporarily unavailable";

// Any one of these docs may carry the stable contract row.
const CONTRACT_DOCS = [
  "docs/runbook.md",
  "docs/db-outage-matrix.md",
  "docs/machine-interface.md",
  "docs/web-v1-contract.md",
];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("outage fixtures must remain offline");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scratch(handler: (c: Context) => Response | Promise<Response>): Hono<{ Bindings: Env }> {
  const control = new Hono<{ Bindings: Env }>();
  control.use("*", requestLog);
  control.get("/probe", handler);
  return control;
}

async function probe(
  handler: (c: Context) => Response | Promise<Response>,
  accept?: string,
): Promise<Response> {
  return scratch(handler).request(
    "/probe",
    { headers: { "cf-ray": REQUEST_ID, ...(accept ? { accept } : {}) } },
    BINDINGS,
  );
}

function assertNoStoreVary(res: Response): void {
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("cache-control")).toContain("private");
  expect(res.headers.get("vary")).toContain("Accept");
}

function assertOutageHtml(html: string): void {
  expect(html).toMatch(/<!doctype html>/i);
  expect(html).toContain("Together We Own");
  expect(html).toContain("We will be right back");
  expect(html).toContain('name="robots" content="noindex, nofollow"');
  expect(html).toContain(REQUEST_ID);
}

async function noDbBindings() {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MODERATOR);
  return { cookie, bindings: { ...BINDINGS, SESSION_STORE: sessions } };
}

describe("FAIL_TO_PASS: the one named constant", () => {
  it("exports OUTAGE_RETRY_AFTER_SECONDS = 60 from the errors barrel", async () => {
    const errors = await import("../src/errors");
    const value = (errors as unknown as Record<string, unknown>).OUTAGE_RETRY_AFTER_SECONDS;
    expect(value).toBe(60);
  });
});

describe("FAIL_TO_PASS: databaseUnavailable", () => {
  it("defaults the HTML twin to Retry-After 60 with identical bytes", async () => {
    const res = await probe((c) => dbUnavailableNext(c), "text/html");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("text/html");
    assertNoStoreVary(res);
    assertOutageHtml(await res.text());
  });

  it("defaults the JSON twin to Retry-After 60 with the exact envelope", async () => {
    const res = await probe((c) => dbUnavailableNext(c), "application/json");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("application/json");
    assertNoStoreVary(res);
    expect(await res.json()).toEqual(OUTAGE_JSON_BODY);
  });

  it("defaults the jsonOnly leg to Retry-After 60 without an Accept header", async () => {
    const res = await probe((c) => dbUnavailableNext(c, true));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(OUTAGE_JSON_BODY);
  });

  it.each(CLAMP_CASES)(
    "clamps retryAfter=$retryAfter to $expected on both twins",
    async ({ retryAfter, expected }) => {
      const html = await probe((c) => dbUnavailableNext(c, false, retryAfter), "text/html");
      const json = await probe((c) => dbUnavailableNext(c, false, retryAfter), "application/json");
      expect(html.status).toBe(503);
      expect(json.status).toBe(503);
      expect(html.headers.get("Retry-After")).toBe(expected);
      expect(json.headers.get("Retry-After")).toBe(expected);
      assertOutageHtml(await html.text());
      expect(await json.json()).toEqual(OUTAGE_JSON_BODY);
    },
  );
});

describe("FAIL_TO_PASS: databaseUnavailableBuffered", () => {
  it("defaults the HTML twin to Retry-After 60 with identical bytes", async () => {
    const res = await probe((c) => dbUnavailableBufferedNext(c), "text/html");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("text/html");
    assertNoStoreVary(res);
    assertOutageHtml(await res.text());
  });

  it("defaults the JSON twin to Retry-After 60 with the exact envelope", async () => {
    const res = await probe((c) => dbUnavailableBufferedNext(c), "application/json");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("application/json");
    assertNoStoreVary(res);
    expect(await res.json()).toEqual(OUTAGE_JSON_BODY);
  });

  it.each(CLAMP_CASES)(
    "clamps retryAfter=$retryAfter to $expected on both twins",
    async ({ retryAfter, expected }) => {
      const html = await probe((c) => dbUnavailableBufferedNext(c, retryAfter), "text/html");
      const json = await probe((c) => dbUnavailableBufferedNext(c, retryAfter), "application/json");
      expect(html.status).toBe(503);
      expect(json.status).toBe(503);
      expect(html.headers.get("Retry-After")).toBe(expected);
      expect(json.headers.get("Retry-After")).toBe(expected);
      assertOutageHtml(await html.text());
      expect(await json.json()).toEqual(OUTAGE_JSON_BODY);
    },
  );
});

describe("FAIL_TO_PASS: eventsUnavailable", () => {
  it("defaults to Retry-After 60 with the exact text body", async () => {
    const res = await probe((c) => eventsUnavailableNext(c));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(EVENTS_TEXT_BODY);
  });

  it.each(CLAMP_CASES)(
    "clamps retryAfter=$retryAfter to $expected",
    async ({ retryAfter, expected }) => {
      const res = await probe((c) => eventsUnavailableNext(c, retryAfter));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe(expected);
      expect(await res.text()).toBe(EVENTS_TEXT_BODY);
    },
  );
});

describe("FAIL_TO_PASS: maintenanceHandler", () => {
  it("defaults to Retry-After 60 with identical bytes", async () => {
    const res = await probe(maintenanceHandlerNext(INVITE));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
    assertOutageHtml(await res.text());
  });

  it.each(CLAMP_CASES)(
    "clamps retryAfter=$retryAfter to $expected",
    async ({ retryAfter, expected }) => {
      const res = await probe(maintenanceHandlerNext(INVITE, retryAfter));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe(expected);
      assertOutageHtml(await res.text());
    },
  );
});

describe("FAIL_TO_PASS: inline db_unavailable JSON legs", () => {
  const WRITES = [
    { method: "POST", path: "/events", body: {} },
    { method: "PATCH", path: `/events/${EVENT_KEY}`, body: {} },
    { method: "POST", path: `/events/${EVENT_KEY}/publish`, body: {} },
    { method: "POST", path: `/events/${EVENT_KEY}/cancel`, body: {} },
    { method: "POST", path: `/events/${EVENT_KEY}/rsvp-pause`, body: {} },
    { method: "POST", path: `/events/${EVENT_KEY}/rsvp-reopen`, body: {} },
    { method: "PUT", path: `/events/${EVENT_KEY}/rsvp`, body: { status: "going" } },
    { method: "DELETE", path: `/events/${EVENT_KEY}/rsvp`, body: {} },
  ];
  const READS = [
    { method: "GET", path: `/events/${EVENT_KEY}` },
    { method: "GET", path: "/events.json" },
  ];

  it.each(WRITES)(
    "$method $path answers 503 + Retry-After 60, body exact",
    async ({ method, path, body }) => {
      const f = await noDbBindings();
      const res = await app.request(
        path,
        {
          method,
          headers: {
            cookie: f.cookie,
            origin: BINDINGS.APP_URL,
            "content-type": "application/json",
            "cf-ray": REQUEST_ID,
          },
          body: JSON.stringify(body),
        },
        f.bindings,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual(INLINE_JSON_BODY);
    },
  );

  it.each(READS)(
    "$method $path answers 503 + Retry-After 60, body exact",
    async ({ method, path }) => {
      const f = await noDbBindings();
      const res = await app.request(
        path,
        { method, headers: { cookie: f.cookie, accept: "application/json", "cf-ray": REQUEST_ID } },
        f.bindings,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual(INLINE_JSON_BODY);
    },
  );
});

describe("FAIL_TO_PASS: route-level outage wiring", () => {
  it("GET /events without a database answers HTML 503 + Retry-After 60", async () => {
    const f = await noDbBindings();
    const res = await app.request(
      "/events",
      { headers: { accept: "text/html", "cf-ray": REQUEST_ID } },
      f.bindings,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toContain("text/html");
    assertNoStoreVary(res);
    assertOutageHtml(await res.text());
  });

  it("GET /events without a database answers JSON 503 + Retry-After 60", async () => {
    const f = await noDbBindings();
    const res = await app.request(
      "/events",
      { headers: { accept: "application/json", "cf-ray": REQUEST_ID } },
      f.bindings,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual(OUTAGE_JSON_BODY);
  });

  it.each(["/events.rss", "/events.ics"])(
    "GET %s without a database answers the events text + Retry-After 60",
    async (path) => {
      const f = await noDbBindings();
      const res = await app.request(path, { headers: { "cf-ray": REQUEST_ID } }, f.bindings);
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(await res.text()).toBe(EVENTS_TEXT_BODY);
    },
  );

  it("the calendar island fragment answers the events text + Retry-After 60", async () => {
    const f = await noDbBindings();
    const res = await app.request(
      "/events",
      { headers: { "x-two-island": "events-calendar", "cf-ray": REQUEST_ID } },
      f.bindings,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.text()).toBe(EVENTS_TEXT_BODY);
  });

  it.each(["text/html", "application/json"])(
    "the global handler renders classified outages with Retry-After 60 for %s",
    async (accept) => {
      const failing = new Hono<{ Bindings: Env }>();
      failing.use("*", requestLog);
      failing.onError(internalErrorHandler);
      failing.get("/", () => {
        throw new Error("query", {
          cause: Object.assign(new Error("private connection details"), { code: "ECONNREFUSED" }),
        });
      });
      const res = await failing.request(
        "/",
        { headers: { accept, "cf-ray": REQUEST_ID } },
        BINDINGS,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(res.headers.get("content-type")).toContain(accept);
      if (accept === "application/json") expect(await res.json()).toEqual(OUTAGE_JSON_BODY);
      else assertOutageHtml(await res.text());
    },
  );
});

describe("FAIL_TO_PASS: stable header contract row", () => {
  it("a runbook/contract doc carries one 503 + Retry-After + 60 row", () => {
    const hits = CONTRACT_DOCS.flatMap((doc) => {
      const lines = readFileSync(resolve(root, doc), "utf8").split("\n");
      return lines
        .filter((line) => /retry-after/i.test(line) && line.includes("503") && line.includes("60"))
        .map((line) => `${doc}: ${line.trim()}`);
    });
    expect(hits, "expected one stable contract row naming 503 + Retry-After + 60").not.toHaveLength(
      0,
    );
  });
});

describe("PASS_TO_PASS: 429 behavior is untouched", () => {
  function throttled(retryAfter?: number): Hono<{ Bindings: Env }> {
    const control = new Hono<{ Bindings: Env }>();
    control.get("/throttled", (c) =>
      retryAfter === undefined ? rateLimitExceeded(c) : rateLimitExceeded(c, retryAfter),
    );
    return control;
  }

  it("defaults to Retry-After 60 with the rate_limited envelope", async () => {
    const res = await throttled().request("/throttled", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({
      code: "rate_limited",
      reason: "rate_limited",
      message: "Too many requests. Try again in 60 seconds.",
      retry_after: 60,
      next: "Wait for Retry-After, then retry.",
    });
  });

  it.each([
    { retryAfter: 0, expected: "1", body: 1 },
    { retryAfter: Number.NaN, expected: "60", body: 60 },
    { retryAfter: 30, expected: "30", body: 30 },
  ])("keeps the 429 clamp for $retryAfter", async ({ retryAfter, expected, body }) => {
    const res = await throttled(retryAfter).request("/throttled", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(expected);
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: body });
  });
});

describe("PASS_TO_PASS: outage bodies gain no retry_after field", () => {
  it("databaseUnavailable JSON carries request_id but no retry_after", async () => {
    const res = await probe((c) => dbUnavailableNext(c), "application/json");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(OUTAGE_JSON_BODY);
    expect(body).not.toHaveProperty("retry_after");
  });

  it("the buffered JSON twin carries request_id but no retry_after", async () => {
    const res = await probe((c) => dbUnavailableBufferedNext(c), "application/json");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(OUTAGE_JSON_BODY);
    expect(body).not.toHaveProperty("retry_after");
  });
});
