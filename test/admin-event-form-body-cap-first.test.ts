// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key
// Acceptance: on the moderator event form posts (create + update), the
// body-size cap is decided before the shared admin-write throttle. An
// oversized body from a signed-in moderator is therefore a 413 that spends
// zero admin-write throttle (the throttle store is not even consulted),
// performs no event store read/write, and stays a 413 — not a 429 — when
// the budget is already spent. Everything else keeps today's order: the
// moderator guard still runs first (guest redirect, non-moderator 403,
// oversized or not), and at/under-cap moderator posts still spend exactly
// one throttle hit before validation and the store.
// Hermetic: in-memory sessions, a counting throttle Sql double, store
// spies and a fail-if-touched Db double; no DATABASE_URL, no sockets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { createEvent, getEvent, recordAccess, updateEvent } from "../src/admin/store";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  recordAccess: vi.fn(),
}));

const KEY = "01J0000000000000000000ABCD";
const MAX = BODY_LIMIT_BYTES.form;
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "Europe/London",
};
const row = {
  id: 1,
  eventKey: KEY,
  title: FORM.title,
  game: FORM.game,
  description: FORM.description,
  location: FORM.location,
  timezone: FORM.timezone,
  capacity: 8,
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

async function mounted(actor: typeof MODERATOR | typeof MEMBER | null, throttle: Throttle) {
  const sessions = createMemorySessionStore();
  const cookie = actor ? await cookieFor(sessions, actor) : "";
  const app = adminApp({ sessionStore: sessions, db });
  const bindings = {
    ...env,
    ADMIN_DB: db,
    THROTTLE_STORE: throttle.store,
  } as unknown as EnvWithThrottle;
  return { app, cookie, bindings };
}

function oversized(cookie: string, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL("/admin/events", env.APP_URL), {
    method: "POST",
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: env.APP_URL,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      ...(advertised ? { "content-length": String(MAX + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

function postForm(cookie: string, values: Record<string, string>) {
  return {
    method: "POST" as const,
    headers: {
      cookie,
      origin: env.APP_URL,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values).toString(),
  };
}

function expectNoStoreWork() {
  expect(getEvent).not.toHaveBeenCalled();
  expect(createEvent).not.toHaveBeenCalled();
  expect(updateEvent).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
}

const formPosts = [
  ["create", "/events"],
  ["update", `/events/${KEY}`],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(row);
  vi.mocked(createEvent).mockResolvedValue({ row, writeBack: null });
  vi.mocked(updateEvent).mockResolvedValue({ row, writeBack: null, childWriteBacks: [] });
  vi.mocked(recordAccess).mockResolvedValue(true);
});

describe("body-size cap precedes the admin-write throttle on event form posts", () => {
  it.each(formPosts)(
    "%s: advertised and streamed oversized bodies are 413 with zero throttle spend and no store read",
    async (_label, path) => {
      for (const advertised of [true, false]) {
        vi.clearAllMocks();
        const throttle = throttleFixture(0);
        const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
        const { request, pull } = oversized(cookie, advertised);
        const response = await app.request(
          new Request(new URL(path, env.APP_URL), request),
          undefined,
          bindings,
        );
        expect(response.status, `advertised=${advertised}`).toBe(413);
        expect(await response.json(), `advertised=${advertised}`).toMatchObject(ERROR);
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

  it.each(formPosts)(
    "%s: oversized beats a spent admin-write budget (413, not 429) and spends nothing",
    async (_label, path) => {
      for (const advertised of [true, false]) {
        vi.clearAllMocks();
        const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
        const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
        const { request } = oversized(cookie, advertised);
        const response = await app.request(
          new Request(new URL(path, env.APP_URL), request),
          undefined,
          bindings,
        );
        expect(response.status, `advertised=${advertised}`).toBe(413);
        expect(await response.json(), `advertised=${advertised}`).toMatchObject(ERROR);
        expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(throttle.count(), `advertised=${advertised}`).toBe(WRITE_THROTTLE_PER_MINUTE);
        expectNoStoreWork();
        await request.body?.cancel().catch(() => {});
      }
    },
  );
});

describe("controls: today's behavior outside the oversized-moderator case", () => {
  it.each(formPosts)(
    "%s: guest is still refused by the guard first, oversized or not, spending no throttle",
    async (_label, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(null, throttle);
      const under = await app.request(path, postForm(cookie, FORM), bindings);
      expect(under.status).toBe(401);
      const { request, pull } = oversized(cookie, true);
      const over = await app.request(
        new Request(new URL(path, env.APP_URL), request),
        undefined,
        bindings,
      );
      expect(over.status).toBe(401);
      expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each(formPosts)(
    "%s: non-moderator is still 403 first, oversized or not, spending no throttle",
    async (_label, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MEMBER, throttle);
      expect((await app.request(path, postForm(cookie, FORM), bindings)).status).toBe(403);
      const { request, pull } = oversized(cookie, true);
      const over = await app.request(
        new Request(new URL(path, env.APP_URL), request),
        undefined,
        bindings,
      );
      expect(over.status).toBe(403);
      expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each(formPosts)(
    "%s: moderator valid under-cap post still spends exactly one admin-write hit and saves",
    async (label, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(path, postForm(cookie, FORM), bindings);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/admin/events/${KEY}`);
      expect(throttle.count()).toBe(1);
      expect(
        throttle.buckets.some((v) => typeof v === "string" && v.startsWith("admin-write:")),
      ).toBe(true);
      if (label === "create") {
        expect(createEvent).toHaveBeenCalledOnce();
        expect(getEvent).not.toHaveBeenCalled();
      } else {
        expect(getEvent).toHaveBeenCalledOnce();
        expect(updateEvent).toHaveBeenCalledOnce();
      }
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it.each(formPosts)(
    "%s: moderator invalid under-cap post is still a 422 after exactly one throttle hit, with no save",
    async (label, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(
        path,
        postForm(cookie, { ...FORM, starts_at: "not-a-time" }),
        bindings,
      );
      expect(response.status).toBe(422);
      expect(await response.text()).toContain('data-testid="form-errors"');
      expect(throttle.count()).toBe(1);
      expect(createEvent).not.toHaveBeenCalled();
      expect(updateEvent).not.toHaveBeenCalled();
      // Update reads the stored event before validation, as today; create does not.
      if (label === "update") expect(getEvent).toHaveBeenCalledOnce();
      else expect(getEvent).not.toHaveBeenCalled();
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it.each(formPosts)(
    "%s: a body of exactly the form cap is not a 413 and spends one hit",
    async (_label, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const base = new URLSearchParams({ ...FORM, pad: "" }).toString();
      const body = new URLSearchParams({
        ...FORM,
        pad: "x".repeat(MAX - base.length),
      }).toString();
      expect(body.length).toBe(MAX);
      const response = await app.request(path, { ...postForm(cookie, FORM), body }, bindings);
      expect(response.status).not.toBe(413);
      expect(throttle.count()).toBe(1);
    },
  );

  it.each(formPosts)(
    "%s: moderator under-cap post with a spent budget is still 429, with no new hit and no store work",
    async (_label, path) => {
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(path, postForm(cookie, FORM), bindings);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
      expectNoStoreWork();
    },
  );
});
