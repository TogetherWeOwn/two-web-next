// Acceptance: Kit public-read 503 legs classify-and-alert.
//
// A code bug (plain TypeError) inside a Kit public-read load must never become
// a silent branded 503: each 503-throw leg emits exactly one `error.alert`
// diagnostic (critical JSON on console.error, exception class + route, never
// the message) and still answers the branded 503 with byte-stable headers.
// Branded throws pass through with no new alert (classification); deliberate
// fail-open legs (session/joinResult null, null database, 404-path suggestions)
// stay silent. The cancelled-event alternatives degrade warns once with the
// exception class while still serving the empty list.
//
// Fail-first on the pre-fix code: the emission and degrade tests below are red
// (no alert/warn line exists); the pin tests are green and must stay green.
// Test files only — the paired build changes the load paths on this branch and
// never edits this file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { PublicEvent } from "../src/events/reads";
import { loadEventsPage } from "../src/kit-events";
import { resolveEventState, type EventStateStore } from "../src/kit-event-states";
import { loadPastArchivePage } from "../src/kit-past-events";

const MARKER = "acceptance-probe-secret-marker";
const MEMBER_ID = "100000000000000111";
const SQL_FRAGMENT = "SELECT * FROM members";
const URI_SECRET = "https://example.test/e/SECRET-PROBE-KEY";

// A code bug whose message carries everything a log line must never repeat:
// the marker stands in for the exception message, plus SQL, bindings, a URI
// and a member identity. Every new line must carry the class only.
const codeBug = () =>
  new TypeError(
    `${MARKER}: cannot read properties of undefined (${SQL_FRAGMENT} WHERE discord_id='${MEMBER_ID}') at ${URI_SECRET}`,
  );
const branded503 = () => Object.assign(new Error("branded outage"), { status: 503 });

const LEAK_NEEDLES = [MARKER, MEMBER_ID, "SELECT", "SECRET-PROBE-KEY", "discord_id"];

function expectLeakFree(line: string, what: string): void {
  for (const needle of LEAK_NEEDLES) {
    expect(line, `${what} must not leak ${needle}`).not.toContain(needle);
  }
}

function alertLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.includes('"error.alert"'));
}

function expectExactlyOneAlert(route: string): void {
  const lines = alertLines();
  expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  expect(parsed.event).toBe("error.alert");
  expect(parsed.level).toBe("critical");
  expect(parsed.exception).toBe("TypeError");
  expect(parsed.error_class).toBe("TypeError");
  expect(parsed.method).toBe("GET");
  expect(parsed.route).toBe(route);
  expect(parsed.fingerprint).toBe(`TypeError@${route}`);
  expectLeakFree(lines[0] as string, "error.alert");
}

function expectSilent(): void {
  expect(alertLines(), "fail-open legs must not alert").toEqual([]);
  expect(vi.mocked(console.warn).mock.calls, "fail-open legs must not warn").toEqual([]);
}

function expectExactlyOneWarnWithClass(): void {
  const calls = vi.mocked(console.warn).mock.calls;
  expect(calls, "expected exactly one warn diagnostic").toHaveLength(1);
  const text = JSON.stringify(calls[0]);
  expect(text, "degrade warn must name the exception class").toContain("TypeError");
  expectLeakFree(text, "degrade warn");
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const eventsEnv = {
  APP_URL: "https://example.test",
  DISCORD_INVITE_URL: "https://discord.gg/example",
} as unknown as Env;

const baseModel = () => ({
  state: { view: "list", month: "2026-10", q: "", past: false, page: 1 },
  upcoming: [],
  past: [],
  zone: "Europe/London",
  totalPages: 1,
  emptyState: null,
  robots: undefined,
  discordFailed: false,
});

function eventsArgs(overrides: Record<string, unknown> = {}) {
  const setHeaders = vi.fn();
  const deleteJoinCookie = vi.fn();
  return {
    args: {
      env: eventsEnv,
      url: new URL("https://example.test/events"),
      method: "GET",
      island: false,
      request: new Request("https://example.test/events"),
      setHeaders,
      deleteJoinCookie,
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      modelForFn: async () => baseModel(),
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
      ...overrides,
    } as Parameters<typeof loadEventsPage>[0],
    setHeaders,
    deleteJoinCookie,
  };
}

const EVENTS_OUTAGE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "Cookie, X-Two-Island",
};
const EVENTS_ANON_HEADERS = {
  "cache-control": "public, max-age=60",
  vary: "Cookie, X-Two-Island",
  "x-two-events-cacheable": "true",
};

describe("kit-events 503 legs classify-and-alert (acceptance)", () => {
  it("dbForFn throwing TypeError alerts once and still answers branded 503", async () => {
    const { args, setHeaders, deleteJoinCookie } = eventsArgs({
      dbForFn: async () => {
        throw codeBug();
      },
    });
    const promise = loadEventsPage(args);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toThrow("Events temporarily unavailable");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(EVENTS_OUTAGE_HEADERS);
    expect(deleteJoinCookie).not.toHaveBeenCalled();
    expectExactlyOneAlert("/events");
  });

  it("modelForFn throwing TypeError alerts once and still answers branded 503", async () => {
    const { args, setHeaders, deleteJoinCookie } = eventsArgs({
      modelForFn: async () => {
        throw codeBug();
      },
    });
    const promise = loadEventsPage(args);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toThrow("Events temporarily unavailable");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(EVENTS_OUTAGE_HEADERS);
    expect(deleteJoinCookie).not.toHaveBeenCalled();
    expectExactlyOneAlert("/events");
  });

  it("branded 503 from modelForFn passes through with no new alert (classification pin)", async () => {
    const { args } = eventsArgs({
      modelForFn: async () => {
        throw branded503();
      },
    });
    await expect(loadEventsPage(args)).rejects.toMatchObject({ status: 503 });
    expectSilent();
  });

  it("sessionForFn throwing stays silent and serves the anonymous list (fail-open pin)", async () => {
    const { args, setHeaders } = eventsArgs({
      sessionForFn: async () => {
        throw codeBug();
      },
    });
    const out = await loadEventsPage(args);
    expect(out).toMatchObject({
      member: false,
      moderator: false,
      joinResult: null,
      queryTooLong: false,
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(EVENTS_ANON_HEADERS);
    expectSilent();
  });

  it("journeyForFn throwing stays silent and leaves the flash for the next load (fail-open pin)", async () => {
    const { args, setHeaders, deleteJoinCookie } = eventsArgs({
      journeyForFn: async () => {
        throw codeBug();
      },
    });
    const out = await loadEventsPage(args);
    expect(out).toMatchObject({ joinResult: null, queryTooLong: false });
    expect(deleteJoinCookie).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(EVENTS_ANON_HEADERS);
    expectSilent();
  });

  it("dbForFn returning null answers a silent branded 503 (null-leg pin)", async () => {
    const { args, setHeaders } = eventsArgs({ dbForFn: async () => null });
    const promise = loadEventsPage(args);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toThrow("Events temporarily unavailable");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(EVENTS_OUTAGE_HEADERS);
    expectSilent();
  });
});

const pastEnv = { APP_URL: "https://example.test" } as unknown as Env;

function pastArgs(overrides: Record<string, unknown> = {}) {
  const setHeaders = vi.fn();
  return {
    args: {
      env: pastEnv,
      pageParam: null,
      setHeaders,
      dbForFn: async () => ({}) as never,
      listPastFn: async () => ({ rows: [], hasMore: false, totalPages: 1 }) as never,
      ...overrides,
    } as Parameters<typeof loadPastArchivePage>[0],
    setHeaders,
  };
}

const PAST_OUTAGE_HEADERS = { "cache-control": "private, no-store" };

describe("kit-past-events 503 legs classify-and-alert (acceptance)", () => {
  it("dbForFn throwing TypeError alerts once and still answers branded 503", async () => {
    const { args, setHeaders } = pastArgs({
      dbForFn: async () => {
        throw codeBug();
      },
    });
    const promise = loadPastArchivePage(args);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toThrow("Events temporarily unavailable");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(PAST_OUTAGE_HEADERS);
    expectExactlyOneAlert("/events/past");
  });

  it("listPastFn throwing TypeError alerts once and still answers branded 503", async () => {
    const { args, setHeaders } = pastArgs({
      listPastFn: async () => {
        throw codeBug();
      },
    });
    const promise = loadPastArchivePage(args);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toThrow("Events temporarily unavailable");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(PAST_OUTAGE_HEADERS);
    expectExactlyOneAlert("/events/past");
  });

  it("branded 503 from listPastFn passes through with no new alert (classification pin)", async () => {
    const { args } = pastArgs({
      listPastFn: async () => {
        throw branded503();
      },
    });
    await expect(loadPastArchivePage(args)).rejects.toMatchObject({ status: 503 });
    expectSilent();
  });

  it("dbForFn returning null answers a silent branded 503 (null-leg pin)", async () => {
    const { args, setHeaders } = pastArgs({ dbForFn: async () => null });
    const promise = loadPastArchivePage(args);
    await expect(promise).rejects.toMatchObject({ status: 503 });
    await expect(promise).rejects.toThrow("Events temporarily unavailable");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(PAST_OUTAGE_HEADERS);
    expectSilent();
  });
});

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const stateEnv = { APP_URL: "https://example.test" } as unknown as Env;

const cancelledEvent = {
  id: 7,
  eventKey: KEY,
  title: "Chess night",
  game: "Chess",
  description: "Bring a friend.",
  startsAt: new Date("2030-01-10T20:00:00Z"),
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "The lobby",
  status: "cancelled",
} as unknown as PublicEvent;

function stateStore(overrides: Partial<EventStateStore> = {}): EventStateStore {
  return {
    dbForFn: async () => ({}) as unknown as Db,
    getEventFn: async () => cancelledEvent,
    relatedFn: async () => [],
    suggestionsFn: async () => [],
    ...overrides,
  };
}

async function resolveState(key: string, store: EventStateStore) {
  const setHeaders = vi.fn();
  const outcome = await resolveEventState({
    key,
    search: "",
    path: `/e/${key}`,
    env: stateEnv,
    setHeaders,
    store,
  });
  return { outcome, setHeaders };
}

const STATE_OUTAGE_HEADERS = { "cache-control": "private, no-store" };
const STATE_GONE_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
};

describe("kit-event-states legs classify-and-alert (acceptance)", () => {
  it("dbForFn throwing TypeError alerts once and still answers unavailable", async () => {
    const { outcome, setHeaders } = await resolveState(
      KEY,
      stateStore({
        dbForFn: async () => {
          throw codeBug();
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: STATE_OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(STATE_OUTAGE_HEADERS);
    expectExactlyOneAlert("/e/:key");
  });

  it("getEventFn throwing TypeError alerts once and still answers unavailable", async () => {
    const { outcome, setHeaders } = await resolveState(
      KEY,
      stateStore({
        getEventFn: async () => {
          throw codeBug();
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: STATE_OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(STATE_OUTAGE_HEADERS);
    expectExactlyOneAlert("/e/:key");
  });

  it("dbForFn returning null answers silent unavailable (null-leg pin)", async () => {
    const { outcome, setHeaders } = await resolveState(
      KEY,
      stateStore({ dbForFn: async () => null }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: STATE_OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(STATE_OUTAGE_HEADERS);
    expectSilent();
  });

  it("relatedFn throwing TypeError warns once with the class and still serves the empty list", async () => {
    const { outcome, setHeaders } = await resolveState(
      KEY,
      stateStore({
        relatedFn: async () => {
          throw codeBug();
        },
      }),
    );
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect(outcome.headers).toEqual(STATE_GONE_HEADERS);
    expect(outcome.model.related).toEqual([]);
    expect(outcome.model).toMatchObject({
      title: "Chess night",
      eventKey: KEY,
      icsUrl: `/events/${KEY}.ics`,
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(STATE_GONE_HEADERS);
    expectExactlyOneWarnWithClass();
    expect(alertLines(), "a degrade warns, it must not alert").toEqual([]);
  });

  it("suggestionsFn throwing stays silent and serves missing with no suggestions (404-path fail-open pin)", async () => {
    // The 404 path degrades without a line: forged and unknown keys already
    // miss, so warning there would page on probe traffic during an outage.
    // Only the 410 alternatives degrade (a real page serving short) warns.
    const { outcome, setHeaders } = await resolveState(
      "nope!!",
      stateStore({
        suggestionsFn: async () => {
          throw codeBug();
        },
      }),
    );
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(outcome.model.suggestions).toEqual([]);
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expectSilent();
  });

  it("branded 503 from getEventFn stays unavailable with no new alert (classification pin)", async () => {
    const { outcome } = await resolveState(
      KEY,
      stateStore({
        getEventFn: async () => {
          throw branded503();
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: STATE_OUTAGE_HEADERS });
    expectSilent();
  });
});
