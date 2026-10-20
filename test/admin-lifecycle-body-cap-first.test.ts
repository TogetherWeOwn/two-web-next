// route-inventory: POST /admin/queue/failed/:id/redispatch
// route-inventory: POST /admin/events/:key/publish
// route-inventory: POST /admin/events/:key/cancel
// route-inventory: POST /admin/events/:key/rsvp-pause
// route-inventory: POST /admin/events/:key/rsvp-reopen
// Acceptance: on the moderator lifecycle actions (publish, cancel,
// rsvp-pause, rsvp-reopen) and the queue redispatch, the body-size cap is
// decided before the shared admin-write throttle. An oversized body from a
// signed-in moderator is therefore a 413 that spends zero admin-write
// throttle (the throttle store is not even consulted), performs no event
// store read/write, loads no redispatch candidate, dispatches nothing, and
// stays a 413 — not a 429 — when the budget is already spent. Everything
// else keeps today's order: the moderator guard (and, for redispatch, the
// staging-operator admission ahead of it) still runs first (guest 401,
// non-moderator 403, oversized or not), and at/under-cap moderator posts
// still spend exactly one throttle hit before validation and the store.
// Hermetic: in-memory sessions, a counting throttle Sql double, store and
// redispatch-deps spies, a mocked audit client and a fail-if-touched Db
// double; no DATABASE_URL is ever connected, no sockets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { getEvent, recordAccess, setRsvpOpen, transitionEvent } from "../src/admin/store";
import { ValidationError } from "../src/admin/validation";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { FailedJobReplayCandidate } from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  getEvent: vi.fn(),
  transitionEvent: vi.fn(),
  setRsvpOpen: vi.fn(),
  recordAccess: vi.fn(),
}));

const pg = vi.hoisted(() => ({ audit: vi.fn(), end: vi.fn(), factory: vi.fn() }));
vi.mock("postgres", () => ({ default: pg.factory }));

const KEY = "01J0000000000000000000ABCD";
const MAX = BODY_LIMIT_BYTES.action;
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const row = {
  id: 1,
  eventKey: KEY,
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  timezone: "Europe/London",
  capacity: 8,
  purpose: null,
  startsAt: new Date("2099-11-04T20:00:00Z"),
  endsAt: new Date("2099-11-04T22:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies typeof events.$inferSelect;

const replayCandidate: FailedJobReplayCandidate = {
  preview: {
    failure: { id: 7, kind: "sync-event", failedAt: "2026-10-07T00:00:00.000Z" },
    observedAt: "2026-10-07T01:00:00.000Z",
    disposition: { action: "replay", reason: "source is still dirty; fresh dispatch" },
  },
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
};

// Any property access is a store read/write the fixture must never perform
// (the store spies above are the only sanctioned store seam).
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
  const buckets: unknown[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    buckets.push(...values);
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const store = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
  return { sql, store, buckets, count: () => hits };
}

type Throttle = ReturnType<typeof throttleFixture>;
type Actor = typeof MODERATOR | typeof MEMBER | null;

async function mounted(actor: Actor, throttle: Throttle, extra: Record<string, unknown> = {}) {
  const sessions = createMemorySessionStore();
  const cookie = actor ? await cookieFor(sessions, actor) : "";
  const app = adminApp({ sessionStore: sessions, db });
  const bindings = {
    ...env,
    ADMIN_DB: db,
    THROTTLE_STORE: throttle.store,
    ...extra,
  } as unknown as EnvWithThrottle;
  return { app, cookie, bindings };
}

function redispatchDeps() {
  const loadCandidate = vi.fn(async () => replayCandidate);
  const dispatch = vi.fn(async () => true);
  const bindings = {
    APP_URL: STAGING_APP_URL,
    DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
    QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
    QUEUE_RECONCILE_OPERATOR_ID: MODERATOR.userId,
    REDISPATCH_DEPS: { loadCandidate, dispatch },
  };
  return { loadCandidate, dispatch, bindings };
}

function oversized(base: string, path: string, cookie: string, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL(path, base), {
    method: "POST",
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: base,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      ...(advertised ? { "content-length": String(MAX + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

function postAction(base: string, cookie: string, body = "") {
  return {
    method: "POST" as const,
    headers: {
      cookie,
      origin: base,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  };
}

function expectNoStoreWork() {
  expect(getEvent).not.toHaveBeenCalled();
  expect(transitionEvent).not.toHaveBeenCalled();
  expect(setRsvpOpen).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
}

function expectAdminWriteBucket(throttle: Throttle) {
  expect(throttle.buckets.some((v) => typeof v === "string" && v.startsWith("admin-write:"))).toBe(
    true,
  );
}

const lifecycle = [
  ["publish", `/events/${KEY}/publish`],
  ["cancel", `/events/${KEY}/cancel`],
  ["rsvp-pause", `/events/${KEY}/rsvp-pause`],
  ["rsvp-reopen", `/events/${KEY}/rsvp-reopen`],
] as const;

const REDISPATCH = "/queue/failed/7/redispatch";
const REDISPATCH_URL = `${STAGING_APP_URL}${REDISPATCH}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(row);
  vi.mocked(transitionEvent).mockResolvedValue({ row, writeBack: null });
  vi.mocked(setRsvpOpen).mockResolvedValue({ row, writeBack: null });
  vi.mocked(recordAccess).mockResolvedValue(true);
  pg.audit.mockResolvedValue([]);
  pg.end.mockResolvedValue(undefined);
  pg.factory.mockImplementation(() =>
    Object.assign(pg.audit, { json: (x: unknown) => x, end: pg.end }),
  );
});

describe("body-size cap precedes the admin-write throttle on lifecycle actions", () => {
  it.each(lifecycle)(
    "%s: advertised and streamed oversized bodies are 413 with zero throttle spend and no store work",
    async (_action, path) => {
      for (const advertised of [true, false]) {
        vi.clearAllMocks();
        const throttle = throttleFixture(0);
        const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
        const { request, pull } = oversized(env.APP_URL, path, cookie, advertised);
        const response = await app.request(request, undefined, bindings);
        expect(response.status, `advertised=${advertised}`).toBe(413);
        expect(await response.json(), `advertised=${advertised}`).toEqual(ERROR);
        expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(throttle.sql, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(throttle.count(), `advertised=${advertised}`).toBe(0);
        expectNoStoreWork();
        if (advertised) expect(pull, `advertised=${advertised}`).not.toHaveBeenCalled();
        else
          expect(pull.mock.calls.length, `advertised=${advertised}`).toBeLessThanOrEqual(
            MAX / 1024 + 2,
          );
        await request.body?.cancel().catch(() => {});
      }
    },
  );

  it.each(lifecycle)(
    "%s: oversized beats a spent admin-write budget (413, not 429) and spends nothing",
    async (_action, path) => {
      for (const advertised of [true, false]) {
        vi.clearAllMocks();
        const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
        const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
        const { request } = oversized(env.APP_URL, path, cookie, advertised);
        const response = await app.request(request, undefined, bindings);
        expect(response.status, `advertised=${advertised}`).toBe(413);
        expect(await response.json(), `advertised=${advertised}`).toEqual(ERROR);
        expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(throttle.count(), `advertised=${advertised}`).toBe(WRITE_THROTTLE_PER_MINUTE);
        expectNoStoreWork();
        await request.body?.cancel().catch(() => {});
      }
    },
  );
});

describe("body-size cap precedes the admin-write throttle on queue redispatch", () => {
  it("advertised and streamed oversized bodies are 413 with zero throttle spend, no candidate load, no dispatch and no audit", async () => {
    for (const advertised of [true, false]) {
      vi.clearAllMocks();
      const throttle = throttleFixture(0);
      const deps = redispatchDeps();
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
      const { request, pull } = oversized(STAGING_APP_URL, REDISPATCH, cookie, advertised);
      const response = await app.request(request, undefined, bindings);
      expect(response.status, `advertised=${advertised}`).toBe(413);
      expect(await response.json(), `advertised=${advertised}`).toEqual(ERROR);
      expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(throttle.sql, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(throttle.count(), `advertised=${advertised}`).toBe(0);
      expect(deps.loadCandidate, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(deps.dispatch, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(pg.factory, `advertised=${advertised}`).not.toHaveBeenCalled();
      expectNoStoreWork();
      if (advertised) expect(pull, `advertised=${advertised}`).not.toHaveBeenCalled();
      else
        expect(pull.mock.calls.length, `advertised=${advertised}`).toBeLessThanOrEqual(
          MAX / 1024 + 2,
        );
      await request.body?.cancel().catch(() => {});
    }
  });

  it("oversized beats a spent admin-write budget (413, not 429) and spends nothing", async () => {
    for (const advertised of [true, false]) {
      vi.clearAllMocks();
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const deps = redispatchDeps();
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
      const { request } = oversized(STAGING_APP_URL, REDISPATCH, cookie, advertised);
      const response = await app.request(request, undefined, bindings);
      expect(response.status, `advertised=${advertised}`).toBe(413);
      expect(await response.json(), `advertised=${advertised}`).toEqual(ERROR);
      expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(throttle.count(), `advertised=${advertised}`).toBe(WRITE_THROTTLE_PER_MINUTE);
      expect(deps.loadCandidate, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(deps.dispatch, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(pg.factory, `advertised=${advertised}`).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    }
  });
});

describe("controls: today's behavior outside the oversized-moderator case", () => {
  it.each(lifecycle)(
    "%s: guest is still refused by the guard first, oversized or not, spending no throttle",
    async (_action, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(null, throttle);
      expect((await app.request(path, postAction(env.APP_URL, cookie), bindings)).status).toBe(401);
      const { request, pull } = oversized(env.APP_URL, path, cookie, true);
      const over = await app.request(request, undefined, bindings);
      expect(over.status).toBe(401);
      expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    },
  );

  it("redispatch: guest is still refused by the guard first, oversized or not, spending no throttle", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(null, throttle, deps.bindings);
    expect(
      (await app.request(REDISPATCH_URL, postAction(STAGING_APP_URL, cookie), bindings)).status,
    ).toBe(401);
    const { request, pull } = oversized(STAGING_APP_URL, REDISPATCH, cookie, true);
    const over = await app.request(request, undefined, bindings);
    expect(over.status).toBe(401);
    expect(pull).not.toHaveBeenCalled();
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    await request.body?.cancel().catch(() => {});
  });

  it.each(lifecycle)(
    "%s: non-moderator is still 403 first, oversized or not, spending no throttle",
    async (_action, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MEMBER, throttle);
      expect((await app.request(path, postAction(env.APP_URL, cookie), bindings)).status).toBe(403);
      const { request, pull } = oversized(env.APP_URL, path, cookie, true);
      const over = await app.request(request, undefined, bindings);
      expect(over.status).toBe(403);
      expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    },
  );

  it("redispatch: non-moderator is still 403 first, oversized or not, spending no throttle", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MEMBER, throttle, deps.bindings);
    expect(
      (await app.request(REDISPATCH_URL, postAction(STAGING_APP_URL, cookie), bindings)).status,
    ).toBe(403);
    const { request, pull } = oversized(STAGING_APP_URL, REDISPATCH, cookie, true);
    const over = await app.request(request, undefined, bindings);
    expect(over.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    await request.body?.cancel().catch(() => {});
  });

  it.each(lifecycle)(
    "%s: moderator valid under-cap post still spends exactly one admin-write hit and applies the action",
    async (action, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(path, postAction(env.APP_URL, cookie), bindings);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/admin/events/${KEY}`);
      expect(throttle.count()).toBe(1);
      expectAdminWriteBucket(throttle);
      if (action === "publish" || action === "cancel") {
        expect(transitionEvent).toHaveBeenCalledOnce();
        expect(vi.mocked(transitionEvent).mock.calls[0]?.slice(2)).toEqual([
          KEY,
          action === "publish" ? "published" : "cancelled",
        ]);
        expect(setRsvpOpen).not.toHaveBeenCalled();
      } else {
        expect(setRsvpOpen).toHaveBeenCalledOnce();
        expect(vi.mocked(setRsvpOpen).mock.calls[0]?.slice(2)).toEqual([
          KEY,
          action === "rsvp-reopen",
        ]);
        expect(transitionEvent).not.toHaveBeenCalled();
      }
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it("redispatch: moderator valid under-cap post still spends exactly one admin-write hit and dispatches", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(
      REDISPATCH_URL,
      postAction(STAGING_APP_URL, cookie),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redispatched: true, ...replayCandidate.preview });
    expect(throttle.count()).toBe(1);
    expectAdminWriteBucket(throttle);
    expect(deps.loadCandidate).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith(
      replayCandidate.eventKey,
      expect.any(String),
    );
    expect(pg.audit).toHaveBeenCalledTimes(1);
    expect(pg.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it.each(lifecycle)(
    "%s: moderator validation failure under-cap is still a 422 after exactly one throttle hit",
    async (action, path) => {
      const failure =
        action === "publish" || action === "cancel"
          ? new ValidationError({ status: "That transition is not allowed from here." })
          : new ValidationError({ rsvp_open: "RSVPs cannot change for this event." });
      if (action === "publish" || action === "cancel")
        vi.mocked(transitionEvent).mockRejectedValueOnce(failure);
      else vi.mocked(setRsvpOpen).mockRejectedValueOnce(failure);
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(path, postAction(env.APP_URL, cookie), bindings);
      expect(response.status).toBe(422);
      expect(throttle.count()).toBe(1);
      if (action === "publish" || action === "cancel") {
        expect(transitionEvent).toHaveBeenCalledOnce();
        expect(setRsvpOpen).not.toHaveBeenCalled();
      } else {
        expect(setRsvpOpen).toHaveBeenCalledOnce();
        expect(transitionEvent).not.toHaveBeenCalled();
      }
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it("redispatch: moderator validation failure under-cap is still a 422 with zero throttle spend, no candidate load", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(
      `${STAGING_APP_URL}/queue/failed/0/redispatch`,
      postAction(STAGING_APP_URL, cookie),
      bindings,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_failure_id" });
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.sql).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.factory).not.toHaveBeenCalled();
  });

  it.each(lifecycle)(
    "%s: a body of exactly the action cap is not a 413 and spends one hit",
    async (_action, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(
        path,
        postAction(env.APP_URL, cookie, "x".repeat(MAX)),
        bindings,
      );
      expect(response.status).not.toBe(413);
      expect(response.status).toBe(303);
      expect(throttle.count()).toBe(1);
    },
  );

  it("redispatch: a body of exactly the action cap is not a 413, spends one hit and dispatches", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(
      REDISPATCH_URL,
      postAction(STAGING_APP_URL, cookie, "x".repeat(MAX)),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(throttle.count()).toBe(1);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it.each(lifecycle)(
    "%s: moderator under-cap post with a spent budget is still 429, with no new hit and no store work",
    async (_action, path) => {
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(path, postAction(env.APP_URL, cookie), bindings);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
      expectNoStoreWork();
    },
  );

  it("redispatch: moderator under-cap post with a spent budget is still 429, with no new hit, no candidate load and no dispatch", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(
      REDISPATCH_URL,
      postAction(STAGING_APP_URL, cookie),
      bindings,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.factory).not.toHaveBeenCalled();
  });
});
