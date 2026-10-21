// Acceptance: a code bug inside a Kit admin read must never look like a
// downstream outage. Each of the five read legs across the four Kit admin
// read models (featured list, featured edit, event edit get, event edit
// roster, join-attempt detail) emits exactly one leak-free `error.alert`
// diagnostic (critical JSON on console.error, exception class only, stable
// route per load) before rethrowing a non-outage error, mirroring the
// activity-log sibling's reportLoadFailure. A classified
// database-unavailable failure keeps the silent `{ kind: "unavailable" }` —
// no over-alerting. Each classify expectation is paired after an alerting
// one in the same case, so a leg that never alerts fails every case.
//
// Fail-first on the pre-fix code: the five alert tests, the five classify
// tests and the shared-route test are red (the legs rethrow with zero
// alerting); the null-database silence pin and the framework-free pin are
// already green and must stay green. Test files only — the paired build
// changes the read models, never this file.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { resolveKitFeaturedList } from "../src/admin/kit-featured";
import { resolveKitFeaturedEdit } from "../src/admin/kit-featured-edit";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRosterRow,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import { resolveKitJoinAttemptDetail } from "../src/admin/kit-join-attempt-detail";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const MARKER = "acceptance-probe-secret-marker";
const EVENT_KEY = "EVTPAST01";
const FEATURED_ID = "4242";
const ATTEMPT_ID = "424242";
// Row content in scope when the roster leg throws: the alert must never
// carry it, only the exception class.
const ROSTER_ROW_SECRET = "roster-probe-event-title-must-not-alert";

const codeBug = () => new TypeError(`${MARKER}: cannot read properties of undefined`);
const transportDown = () =>
  Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const serverDown = () => {
  const err = new Error(`${MARKER}: the database system is starting up`);
  err.name = "PostgresError";
  return Object.assign(err, { code: "57P03" });
};

function alertLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.includes('"error.alert"'));
}

type ParsedAlert = {
  event?: unknown;
  level?: unknown;
  method?: unknown;
  route?: unknown;
  fingerprint?: unknown;
  exception?: unknown;
  error_class?: unknown;
  request_id?: unknown;
};

/** Exactly one class-only line for this load's stable route, with no leaked content. */
function expectExactlyOneAlert(expectedRoute: string, expectedClass = "TypeError") {
  const lines = alertLines();
  expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
  const parsed = JSON.parse(lines[0] as string) as ParsedAlert;
  expect(parsed.event).toBe("error.alert");
  expect(parsed.level).toBe("critical");
  expect(parsed.method).toBe("GET");
  expect(parsed.route).toBe(expectedRoute);
  expect(parsed.fingerprint).toBe(`${expectedClass}@${expectedRoute}`);
  expect(parsed.exception).toBe(expectedClass);
  expect(parsed.error_class).toBe(expectedClass);
  // Leak assertions: the exception message, any request/trace identifier,
  // filter or cookie material, and row content stay out of the alert. These
  // resolvers carry no request context, so no request_id key is emitted at
  // all (JSON drops the undefined value), exactly like the sibling.
  expect(parsed.request_id).toBeUndefined();
  for (const secret of [
    MARKER,
    "request_id",
    "subject",
    "causer",
    "cookie",
    ROSTER_ROW_SECRET,
    EVENT_KEY,
    FEATURED_ID,
    ATTEMPT_ID,
  ]) {
    expect(lines[0]).not.toContain(secret);
  }
}

const featuredEditRow = () => ({
  id: Number(FEATURED_ID),
  legacyId: null,
  title: "Game night",
  body: "Bring a friend",
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: true,
  position: 2,
  startsAt: null,
  endsAt: null,
  createdBy: null,
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
  updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  startsAtText: null,
  endsAtText: null,
});

const eventRow: KitEventEditRow = {
  eventKey: EVENT_KEY,
  title: ROSTER_ROW_SECRET,
  game: "Chess",
  description: "Casual play",
  startsAt: new Date("2026-07-01T19:00:00.000Z"),
  endsAt: new Date("2026-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};

const eventRoster: { rows: KitEventEditRosterRow[]; total: number } = {
  rows: [{ username: "mod", status: "going", answeredAt: new Date("2026-06-01T12:00:00.000Z") }],
  total: 1,
};

function eventDeps(overrides: Partial<KitEventEditDeps> = {}): KitEventEditDeps {
  return {
    db: {} as never,
    get: async () => ({ ...eventRow }),
    list: async () => ({ ...eventRoster, rows: [...eventRoster.rows] }),
    now: new Date("2026-06-15T12:00:00.000Z"),
    ...overrides,
  };
}

const attemptRow = () => ({
  id: Number(ATTEMPT_ID),
  outcome: "added",
  source: "join",
  requestId: "detail-request",
  discordId: "100000000000000201",
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
});

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Kit admin read code-bug alerts: featured list (acceptance)", () => {
  it("a TypeError from list emits one error.alert and rethrows the same error", async () => {
    const bug = codeBug();
    await expect(
      resolveKitFeaturedList({}, { db: {} as never, list: () => Promise.reject(bug) }),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/featured");
  });

  it("classifies: TypeError alerts, unavailable failures return unavailable with no new alert", async () => {
    const bug = codeBug();
    await expect(
      resolveKitFeaturedList({}, { db: {} as never, list: () => Promise.reject(bug) }),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/featured");

    for (const unavailable of [transportDown, serverDown]) {
      await expect(
        resolveKitFeaturedList({}, { db: {} as never, list: () => Promise.reject(unavailable()) }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });
});

describe("Kit admin read code-bug alerts: featured edit (acceptance)", () => {
  it("a TypeError from get emits one error.alert and rethrows the same error", async () => {
    const bug = codeBug();
    await expect(
      resolveKitFeaturedEdit(FEATURED_ID, { db: {} as never, get: () => Promise.reject(bug) }),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/featured/:id");
  });

  it("classifies: TypeError alerts, unavailable failures return unavailable with no new alert", async () => {
    const bug = codeBug();
    await expect(
      resolveKitFeaturedEdit(FEATURED_ID, { db: {} as never, get: () => Promise.reject(bug) }),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/featured/:id");

    for (const unavailable of [transportDown, serverDown]) {
      await expect(
        resolveKitFeaturedEdit(FEATURED_ID, {
          db: {} as never,
          get: () => Promise.reject(unavailable()),
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });
});

describe("Kit admin read code-bug alerts: event edit (acceptance)", () => {
  it("a TypeError from get emits one error.alert and rethrows the same error", async () => {
    const bug = codeBug();
    await expect(
      resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ get: () => Promise.reject(bug) })),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/events/:key");
  });

  it("get classifies: TypeError alerts, unavailable failures return unavailable with no new alert", async () => {
    const bug = codeBug();
    await expect(
      resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ get: () => Promise.reject(bug) })),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/events/:key");

    for (const unavailable of [transportDown, serverDown]) {
      await expect(
        resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ get: () => Promise.reject(unavailable()) })),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });

  it("a TypeError from the roster list emits one error.alert and rethrows the same error", async () => {
    const bug = codeBug();
    await expect(
      resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ list: () => Promise.reject(bug) })),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/events/:key");
  });

  it("roster classifies: TypeError alerts, unavailable failures return unavailable with no new alert", async () => {
    const bug = codeBug();
    await expect(
      resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ list: () => Promise.reject(bug) })),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/events/:key");

    for (const unavailable of [transportDown, serverDown]) {
      await expect(
        resolveKitEventEdit(
          EVENT_KEY,
          {},
          eventDeps({ list: () => Promise.reject(unavailable()) }),
        ),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });

  it("get and roster legs share one stable route so the fingerprint mute dedupes repeats", async () => {
    await expect(
      resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ get: () => Promise.reject(codeBug()) })),
    ).rejects.toBeInstanceOf(TypeError);
    // The shared route means a shared fingerprint: clear the 5-minute mute
    // so the second leg's emission is asserted, not the mute.
    __resetAlertRateLimitForTests();
    await expect(
      resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ list: () => Promise.reject(codeBug()) })),
    ).rejects.toBeInstanceOf(TypeError);
    const lines = alertLines();
    expect(lines, "expected one error.alert per leg").toHaveLength(2);
    const routes = lines.map((line) => (JSON.parse(line) as ParsedAlert).route);
    expect(routes).toEqual(["/admin/events/:key", "/admin/events/:key"]);
    const fingerprints = lines.map((line) => (JSON.parse(line) as ParsedAlert).fingerprint);
    expect(fingerprints).toEqual(["TypeError@/admin/events/:key", "TypeError@/admin/events/:key"]);
  });
});

describe("Kit admin read code-bug alerts: join-attempt detail (acceptance)", () => {
  it("a TypeError from get emits one error.alert and rethrows the same error", async () => {
    const bug = codeBug();
    await expect(
      resolveKitJoinAttemptDetail(ATTEMPT_ID, {
        db: {} as never,
        get: () => Promise.reject(bug),
      }),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/join-attempts/:id");
  });

  it("classifies: TypeError alerts, unavailable failures return unavailable with no new alert", async () => {
    const bug = codeBug();
    await expect(
      resolveKitJoinAttemptDetail(ATTEMPT_ID, {
        db: {} as never,
        get: () => Promise.reject(bug),
      }),
    ).rejects.toBe(bug);
    expectExactlyOneAlert("/admin/join-attempts/:id");

    for (const unavailable of [transportDown, serverDown]) {
      await expect(
        resolveKitJoinAttemptDetail(ATTEMPT_ID, {
          db: {} as never,
          get: () => Promise.reject(unavailable()),
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });
});

describe("Kit admin read code-bug alerts: silence and boundaries (acceptance)", () => {
  it("a null database answers unavailable on every leg with zero alert lines", async () => {
    await expect(resolveKitFeaturedList({}, { db: null, list: async () => [] })).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(
      resolveKitFeaturedEdit(FEATURED_ID, { db: null, get: async () => featuredEditRow() }),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(resolveKitEventEdit(EVENT_KEY, {}, eventDeps({ db: null }))).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(
      resolveKitJoinAttemptDetail(ATTEMPT_ID, {
        db: null,
        get: async () => ({ attempt: attemptRow() }),
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(alertLines()).toEqual([]);
  });

  it("the four read models stay framework-free: no Hono, SvelteKit or worker imports", () => {
    for (const path of [
      "src/admin/kit-featured.ts",
      "src/admin/kit-featured-edit.ts",
      "src/admin/kit-event-edit.ts",
      "src/admin/kit-join-attempt-detail.ts",
    ]) {
      const specifiers = [
        ...read(path).matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm),
      ].map((m) => m[1] as string);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier.startsWith(".")).toBe(true);
        expect(specifier).not.toMatch(/hono|svelte|cloudflare/i);
      }
    }
  });
});
