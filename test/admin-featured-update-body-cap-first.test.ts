// route-inventory: POST /admin/featured/:id
// Acceptance: on the moderator featured update post (POST /featured/:id,
// featured cap), the body-size cap is decided before the shared admin-write
// throttle. An oversized body from a signed-in moderator is therefore a
// 413 that spends zero admin-write throttle (the throttle store is not
// even consulted), performs no featured store read/write, and stays a
// 413 — not a 429 — when the budget is already spent. Everything else
// keeps today's order: the moderator guard still runs first (guest 401,
// non-moderator 403, oversized or not), and at/under-cap moderator posts
// still spend exactly one throttle hit before validation and the store.
// Hermetic: in-memory sessions, a counting throttle Sql double, store
// spies and a fail-if-touched Db double; no DATABASE_URL, no sockets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  featuredSaveBaseline,
  getFeatured,
  recordAccess,
  updateFeatured,
} from "../src/admin/store";
import type { FeaturedEditRow } from "../src/admin/store";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  getFeatured: vi.fn(),
  updateFeatured: vi.fn(),
  recordAccess: vi.fn(),
}));

const ID = 7;
const PATH = `/featured/${ID}`;
const CAP = BODY_LIMIT_BYTES.featured;
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const row = {
  id: ID,
  legacyId: null,
  title: "Game night",
  body: "Bring a friend",
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: false,
  position: 0,
  startsAt: null,
  endsAt: null,
  startsAtText: null,
  endsAtText: null,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies FeaturedEditRow;
// The under-cap controls submit the row's real saved-content baseline, the
// way a rendered edit form carries it; only the store comparison is mocked.
const FORM = {
  title: row.title,
  body: row.body ?? "",
  position: String(row.position),
  saved_baseline: await featuredSaveBaseline(row),
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

function oversized(cookie: string, path: string, cap: number, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL(path, env.APP_URL), {
    method: "POST",
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: env.APP_URL,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      ...(advertised ? { "content-length": String(cap + 1) } : {}),
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
  expect(getFeatured).not.toHaveBeenCalled();
  expect(updateFeatured).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFeatured).mockResolvedValue(row);
  vi.mocked(updateFeatured).mockResolvedValue(row);
  vi.mocked(recordAccess).mockResolvedValue(true);
});

describe("body-size cap precedes the admin-write throttle on featured update", () => {
  it("advertised and streamed oversized bodies are 413 with zero throttle spend and no store read", async () => {
    for (const advertised of [true, false]) {
      vi.clearAllMocks();
      vi.mocked(getFeatured).mockResolvedValue(row);
      vi.mocked(updateFeatured).mockResolvedValue(row);
      vi.mocked(recordAccess).mockResolvedValue(true);
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const { request, pull } = oversized(cookie, PATH, CAP, advertised);
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
          CAP / 1024 + 2,
        );
      await request.body?.cancel().catch(() => {});
    }
  });

  it("oversized beats a spent admin-write budget (413, not 429) and spends nothing", async () => {
    for (const advertised of [true, false]) {
      vi.clearAllMocks();
      vi.mocked(getFeatured).mockResolvedValue(row);
      vi.mocked(updateFeatured).mockResolvedValue(row);
      vi.mocked(recordAccess).mockResolvedValue(true);
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const { request } = oversized(cookie, PATH, CAP, advertised);
      const response = await app.request(request, undefined, bindings);
      expect(response.status, `advertised=${advertised}`).toBe(413);
      expect(await response.json(), `advertised=${advertised}`).toEqual(ERROR);
      expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
      expect(throttle.count(), `advertised=${advertised}`).toBe(WRITE_THROTTLE_PER_MINUTE);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    }
  });

  it("a real body above 256 KiB is 413 with zero throttle spend and no store read", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const base = new URLSearchParams({ ...FORM, pad: "" }).toString();
    const body = new URLSearchParams({
      ...FORM,
      pad: "x".repeat(BODY_LIMIT_BYTES.featured + 1024 - base.length),
    }).toString();
    expect(body.length).toBe(BODY_LIMIT_BYTES.featured + 1024);
    expect(body.length).toBeGreaterThan(256 * 1024);
    const response = await app.request(PATH, { ...postForm(cookie, FORM), body }, bindings);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(ERROR);
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.sql).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoStoreWork();
  });
});

describe("controls: today's behavior outside the oversized-moderator case", () => {
  it("guest is still refused by the guard first, oversized or not, spending no throttle", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(null, throttle);
    const under = await app.request(PATH, postForm(cookie, FORM), bindings);
    expect(under.status).toBe(401);
    const { request, pull } = oversized(cookie, PATH, CAP, true);
    const over = await app.request(request, undefined, bindings);
    expect(over.status).toBe(401);
    expect(pull).not.toHaveBeenCalled();
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoStoreWork();
    await request.body?.cancel().catch(() => {});
  });

  it("non-moderator is still 403 first, oversized or not, spending no throttle", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MEMBER, throttle);
    expect((await app.request(PATH, postForm(cookie, FORM), bindings)).status).toBe(403);
    const { request, pull } = oversized(cookie, PATH, CAP, true);
    const over = await app.request(request, undefined, bindings);
    expect(over.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoStoreWork();
    await request.body?.cancel().catch(() => {});
  });

  it("moderator valid under-cap post still spends exactly one admin-write hit and saves", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request(PATH, postForm(cookie, FORM), bindings);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin/featured/${ID}`);
    expect(throttle.count()).toBe(1);
    expect(
      throttle.buckets.some((v) => typeof v === "string" && v.startsWith("admin-write:")),
    ).toBe(true);
    expect(getFeatured).toHaveBeenCalledOnce();
    expect(updateFeatured).toHaveBeenCalledOnce();
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it("moderator invalid under-cap post is still a 422 after exactly one throttle hit, with no save", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request(PATH, postForm(cookie, { ...FORM, title: "" }), bindings);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('data-testid="form-errors"');
    expect(throttle.count()).toBe(1);
    expect(getFeatured).toHaveBeenCalledOnce();
    expect(updateFeatured).not.toHaveBeenCalled();
  });

  it("moderator missing-id under-cap post is still a 404 after exactly one throttle hit, with no save", async () => {
    vi.mocked(getFeatured).mockResolvedValue(null);
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request(PATH, postForm(cookie, FORM), bindings);
    expect(response.status).toBe(404);
    expect(throttle.count()).toBe(1);
    expect(getFeatured).toHaveBeenCalledOnce();
    expect(updateFeatured).not.toHaveBeenCalled();
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it("moderator malformed-id under-cap post is still a 404 after exactly one throttle hit, with no store read", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request("/featured/not-an-id", postForm(cookie, FORM), bindings);
    expect(response.status).toBe(404);
    expect(throttle.count()).toBe(1);
    expectNoStoreWork();
  });

  it("a body of exactly the route cap is not a 413 and spends one hit", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const base = new URLSearchParams({ ...FORM, pad: "" }).toString();
    const body = new URLSearchParams({
      ...FORM,
      pad: "x".repeat(CAP - base.length),
    }).toString();
    expect(body.length).toBe(CAP);
    const response = await app.request(PATH, { ...postForm(cookie, FORM), body }, bindings);
    expect(response.status).not.toBe(413);
    expect(throttle.count()).toBe(1);
  });

  it("moderator under-cap post with a spent budget is still 429, with no new hit and no store read", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request(PATH, postForm(cookie, FORM), bindings);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expectNoStoreWork();
  });
});
