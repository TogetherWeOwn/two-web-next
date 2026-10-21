// Pins: Kit public-read 503 diagnostics owned by the build card.
//
// The acceptance file (kit-public-read-503-alerts-acceptance.test.ts) is
// frozen: the paired card owns it and this card never edits it. This file
// pins what review follow-ups added instead:
// - the wired Kit event-detail legs (resolveKitEventDetail): both read legs
//   alert once through one shared classifier, the null handle and the
//   indeterminate-session leg stay silent, the cancelled alternatives
//   degrade warns once with the class;
// - request_id threading: every loader forwards a validated cf-ray into its
//   alert/warn lines and drops anything else, and each Kit binding threads
//   the header through (source-pinned, since deleting the threading is
//   otherwise invisible);
// - the event-states database-leg branded classification, which is
//   per-leg logic the acceptance suite only pins on the lookup leg.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { PublicEvent } from "../src/events/reads";
import { loadEventsPage } from "../src/kit-events";
import { resolveEventState, type EventStateStore } from "../src/kit-event-states";
import { loadPastArchivePage } from "../src/kit-past-events";
import type { KitRequestSession } from "../src/kit-session";

const MARKER = "acceptance-probe-secret-marker";
const MEMBER_ID = "100000000000000111";
const SQL_FRAGMENT = "SELECT * FROM members";
const URI_SECRET = "https://example.test/e/SECRET-PROBE-KEY";
// Valid cf-ray form (16 hex plus colo suffix); hostile values must be dropped.
const RAY = "7f3a9c2e5b1d48f6-AMS";
const HOSTILE = "not-a-ray\nSELECT * FROM members";

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

function expectExactlyOneAlert(route: string, requestId?: string): void {
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
  if (requestId === undefined) {
    expect(parsed.request_id).toBeUndefined();
  } else {
    expect(parsed.request_id).toBe(requestId);
  }
  expectLeakFree(lines[0] as string, "error.alert");
}

function expectSilent(): void {
  expect(alertLines(), "fail-open legs must not alert").toEqual([]);
  expect(vi.mocked(console.warn).mock.calls, "fail-open legs must not warn").toEqual([]);
}

function expectExactlyOneWarnWithClass(requestId?: string): void {
  const calls = vi.mocked(console.warn).mock.calls;
  expect(calls, "expected exactly one warn diagnostic").toHaveLength(1);
  const [message, fields] = calls[0] as [unknown, Record<string, unknown>];
  expect(message).toBe("Event alternatives unavailable; serving the empty list.");
  expect(fields.exception).toBe("TypeError");
  if (requestId === undefined) {
    expect(fields.request_id).toBeUndefined();
  } else {
    expect(fields.request_id).toBe(requestId);
  }
  expectLeakFree(JSON.stringify(calls[0]), "degrade warn");
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

const publishedEvent = { ...cancelledEvent, status: "published" } as unknown as PublicEvent;

const GUEST: KitRequestSession = { status: "guest", session: null };
const UNKNOWN: KitRequestSession = { status: "unknown", session: null };

function stateStore(overrides: Partial<EventStateStore> = {}): EventStateStore {
  return {
    dbForFn: async () => ({}) as unknown as Db,
    getEventFn: async () => cancelledEvent,
    relatedFn: async () => [],
    suggestionsFn: async () => [],
    ...overrides,
  };
}

async function resolveState(key: string, store: EventStateStore, requestId?: string) {
  const setHeaders = vi.fn();
  const outcome = await resolveEventState({
    key,
    search: "",
    path: `/e/${key}`,
    env: stateEnv,
    setHeaders,
    store,
    requestId,
  });
  return { outcome, setHeaders };
}

function detailStore(overrides: Partial<KitEventDetailStore> = {}): KitEventDetailStore {
  const unreachable = async (): Promise<never> => {
    throw new Error("unreachable");
  };
  return {
    dbForFn: async () => ({}) as unknown as Db,
    getEventFn: async () => cancelledEvent,
    neighborsFn: unreachable,
    relatedFn: async () => [],
    attendeesFn: unreachable,
    viewerRsvpFn: unreachable,
    waitlistFn: unreachable,
    suggestionsFn: async () => [],
    ...overrides,
  };
}

async function resolveDetail(
  key: string,
  store: KitEventDetailStore,
  session: KitRequestSession = GUEST,
  requestId?: string,
) {
  const setHeaders = vi.fn();
  const outcome = await resolveKitEventDetail({
    key,
    search: "",
    path: `/e/${key}`,
    env: stateEnv,
    session,
    joinResult: null,
    setHeaders,
    store,
    requestId,
  });
  return { outcome, setHeaders };
}

const OUTAGE_HEADERS = { "cache-control": "private, no-store" };
const GONE_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
};

describe("wired Kit detail legs classify-and-alert (pins)", () => {
  it("dbForFn throwing TypeError alerts once with the validated cf-ray and still answers unavailable", async () => {
    const { outcome, setHeaders } = await resolveDetail(
      KEY,
      detailStore({
        dbForFn: async () => {
          throw codeBug();
        },
      }),
      GUEST,
      RAY,
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(OUTAGE_HEADERS);
    expectExactlyOneAlert("/e/:key", RAY);
  });

  it("getEventFn throwing TypeError alerts once and still answers unavailable", async () => {
    const { outcome, setHeaders } = await resolveDetail(
      KEY,
      detailStore({
        getEventFn: async () => {
          throw codeBug();
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(OUTAGE_HEADERS);
    expectExactlyOneAlert("/e/:key");
  });

  it("branded 503 from getEventFn stays unavailable with no new alert (classification pin)", async () => {
    // One shared classifier covers both detail read legs, so one branded pin
    // covers it (unlike the per-leg event-states guards).
    const { outcome, setHeaders } = await resolveDetail(
      KEY,
      detailStore({
        getEventFn: async () => {
          throw branded503();
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(OUTAGE_HEADERS);
    expectSilent();
  });

  it("dbForFn returning null answers silent unavailable (null-leg pin)", async () => {
    const { outcome, setHeaders } = await resolveDetail(
      KEY,
      detailStore({ dbForFn: async () => null }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(OUTAGE_HEADERS);
    expectSilent();
  });

  it("relatedFn throwing TypeError warns once with the class and still serves the empty list", async () => {
    const { outcome, setHeaders } = await resolveDetail(
      KEY,
      detailStore({
        relatedFn: async () => {
          throw codeBug();
        },
      }),
    );
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect(outcome.headers).toEqual(GONE_HEADERS);
    expect(outcome.model.related).toEqual([]);
    expect(outcome.model).toMatchObject({
      title: "Chess night",
      eventKey: KEY,
      icsUrl: `/events/${KEY}.ics`,
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(GONE_HEADERS);
    expectExactlyOneWarnWithClass();
    expect(alertLines(), "a degrade warns, it must not alert").toEqual([]);
  });

  it("indeterminate session answers silent unavailable (deliberate silent-leg pin)", async () => {
    const { outcome, setHeaders } = await resolveDetail(
      KEY,
      detailStore({ getEventFn: async () => publishedEvent }),
      UNKNOWN,
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(OUTAGE_HEADERS);
    expectSilent();
  });
});

describe("event-states database-leg branded classification (pins)", () => {
  it("branded 503 from dbForFn stays unavailable with no new alert", async () => {
    // Per-leg guard: the acceptance suite pins the lookup leg only, so this
    // pins the database leg against an unconditional alert.
    const { outcome, setHeaders } = await resolveState(
      KEY,
      stateStore({
        dbForFn: async () => {
          throw branded503();
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable", status: 503, headers: OUTAGE_HEADERS });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(OUTAGE_HEADERS);
    expectSilent();
  });
});

describe("request_id threading (pins)", () => {
  it("events alert carries the validated cf-ray", async () => {
    const { args } = eventsArgs({
      dbForFn: async () => {
        throw codeBug();
      },
      requestId: RAY,
    });
    await expect(loadEventsPage(args)).rejects.toMatchObject({ status: 503 });
    expectExactlyOneAlert("/events", RAY);
  });

  it("events page-model alert carries the validated cf-ray", async () => {
    // Second events leg: the modelForFn call-site argument into the shared
    // helper is independent of the database leg's, so it needs its own pin.
    const { args } = eventsArgs({
      modelForFn: async () => {
        throw codeBug();
      },
      requestId: RAY,
    });
    await expect(loadEventsPage(args)).rejects.toMatchObject({ status: 503 });
    expectExactlyOneAlert("/events", RAY);
  });

  it("past-archive alert carries the validated cf-ray", async () => {
    const { args } = pastArgs({
      listPastFn: async () => {
        throw codeBug();
      },
      requestId: RAY,
    });
    await expect(loadPastArchivePage(args)).rejects.toMatchObject({ status: 503 });
    expectExactlyOneAlert("/events/past", RAY);
  });

  it("past-archive database-leg alert carries the validated cf-ray", async () => {
    // Second archive leg: the dbForFn call-site argument is independent of
    // the lookup leg's, so it needs its own pin.
    const { args } = pastArgs({
      dbForFn: async () => {
        throw codeBug();
      },
      requestId: RAY,
    });
    await expect(loadPastArchivePage(args)).rejects.toMatchObject({ status: 503 });
    expectExactlyOneAlert("/events/past", RAY);
  });

  it("event-states alert carries the validated cf-ray", async () => {
    await resolveState(
      KEY,
      stateStore({
        getEventFn: async () => {
          throw codeBug();
        },
      }),
      RAY,
    );
    expectExactlyOneAlert("/e/:key", RAY);
  });

  it("event-states database-leg alert carries the validated cf-ray", async () => {
    // Second states leg: an independent inline alertRequestError call, so it
    // needs its own pin (same per-leg grain as its branded guard).
    await resolveState(
      KEY,
      stateStore({
        dbForFn: async () => {
          throw codeBug();
        },
      }),
      RAY,
    );
    expectExactlyOneAlert("/e/:key", RAY);
  });

  it("wired detail alert carries the validated cf-ray", async () => {
    await resolveDetail(
      KEY,
      detailStore({
        getEventFn: async () => {
          throw codeBug();
        },
      }),
      GUEST,
      RAY,
    );
    expectExactlyOneAlert("/e/:key", RAY);
  });

  it("hostile requestId is dropped from the alert", async () => {
    const { args } = eventsArgs({
      dbForFn: async () => {
        throw codeBug();
      },
      requestId: HOSTILE,
    });
    await expect(loadEventsPage(args)).rejects.toMatchObject({ status: 503 });
    const lines = alertLines();
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.request_id).toBeUndefined();
    expectLeakFree(lines[0] as string, "error.alert");
  });

  it("event-states degrade warn carries the validated cf-ray", async () => {
    await resolveState(
      KEY,
      stateStore({
        relatedFn: async () => {
          throw codeBug();
        },
      }),
      RAY,
    );
    expectExactlyOneWarnWithClass(RAY);
  });

  it("wired detail degrade warn carries the validated cf-ray", async () => {
    await resolveDetail(
      KEY,
      detailStore({
        relatedFn: async () => {
          throw codeBug();
        },
      }),
      GUEST,
      RAY,
    );
    expectExactlyOneWarnWithClass(RAY);
  });

  it("hostile requestId is dropped from the degrade warn", async () => {
    await resolveState(
      KEY,
      stateStore({
        relatedFn: async () => {
          throw codeBug();
        },
      }),
      HOSTILE,
    );
    expectExactlyOneWarnWithClass();
  });
});

describe("binding request-id threading (source pins)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const bindingSource = (path: string) => readFileSync(join(root, path), "utf8");

  // The bindings thread the dispatch's served id (admitted ray or minted
  // ULID), never the raw header: with no valid cf-ray the dispatch mints a
  // ULID for the 503 page and x-request-id, and an alert naming only the
  // header would log a null request_id the operator cannot join.
  it("pins the /events binding threading the dispatch request id", () => {
    const source = bindingSource("web/src/routes/events/+server.ts");
    expect(source).toContain("requestId: locals.requestId");
    expect(source).not.toContain('request.headers.get("cf-ray")');
  });

  it("pins the /events/past binding threading the dispatch request id", () => {
    const source = bindingSource("web/src/routes/events/past/+page.server.ts");
    expect(source).toContain("requestId: locals.requestId");
    expect(source).not.toContain('request.headers.get("cf-ray")');
  });

  it("pins the /e/:key binding threading the dispatch request id", () => {
    const source = bindingSource("web/src/routes/e/[key]/+page.server.ts");
    expect(source).toContain("requestId: locals.requestId");
    expect(source).not.toContain('request.headers.get("cf-ray")');
  });
});
