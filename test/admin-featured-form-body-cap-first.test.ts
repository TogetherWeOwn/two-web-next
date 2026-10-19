// route-inventory: POST /admin/featured
// route-inventory: POST /admin/featured/:id/delete
// Acceptance: on the moderator featured posts in scope (create
// POST /featured, featured cap; delete POST /featured/:id/delete, action
// cap), the body-size cap is decided before the shared admin-write
// throttle. An oversized body from a signed-in moderator is therefore a
// 413 that spends zero admin-write throttle (the throttle store is not
// even consulted), performs no featured store read/write, and stays a
// 413 — not a 429 — when the budget is already spent. Everything else
// keeps today's order: the moderator guard still runs first (guest 401,
// non-moderator 403, oversized or not), and at/under-cap moderator posts
// still spend exactly one throttle hit before validation and the store.
// The featured update post (POST /featured/:id) is not in scope here.
// Hermetic: in-memory sessions, a counting throttle Sql double, store
// spies and a fail-if-touched Db double; no DATABASE_URL, no sockets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { createFeatured, deleteFeatured, recordAccess } from "../src/admin/store";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createFeatured: vi.fn(),
  deleteFeatured: vi.fn(),
  recordAccess: vi.fn(),
}));

const ID = 7;
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const FORM = {
  title: "Game night",
  body: "Bring a friend",
  position: "0",
};
const row = {
  id: ID,
  legacyId: null,
  title: FORM.title,
  body: FORM.body,
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: false,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies typeof featuredContents.$inferSelect;

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
  expect(createFeatured).not.toHaveBeenCalled();
  expect(deleteFeatured).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
}

const featuredPosts = [
  ["create", "/featured", BODY_LIMIT_BYTES.featured],
  ["delete", `/featured/${ID}/delete`, BODY_LIMIT_BYTES.action],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFeatured).mockResolvedValue(row);
  vi.mocked(deleteFeatured).mockResolvedValue(undefined);
  vi.mocked(recordAccess).mockResolvedValue(true);
});

describe("body-size cap precedes the admin-write throttle on featured posts", () => {
  it.each(featuredPosts)(
    "%s: advertised and streamed oversized bodies are 413 with zero throttle spend and no store work",
    async (_label, path, cap) => {
      for (const advertised of [true, false]) {
        vi.clearAllMocks();
        const throttle = throttleFixture(0);
        const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
        const { request, pull } = oversized(cookie, path, cap, advertised);
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
            cap / 1024 + 2,
          );
        await request.body?.cancel().catch(() => {});
      }
    },
  );

  it.each(featuredPosts)(
    "%s: oversized beats a spent admin-write budget (413, not 429) and spends nothing",
    async (_label, path, cap) => {
      for (const advertised of [true, false]) {
        vi.clearAllMocks();
        const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
        const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
        const { request } = oversized(cookie, path, cap, advertised);
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

  it("create: a real body above 256 KiB is 413 with zero throttle spend and no store work", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const base = new URLSearchParams({ ...FORM, pad: "" }).toString();
    const body = new URLSearchParams({
      ...FORM,
      pad: "x".repeat(BODY_LIMIT_BYTES.featured + 1024 - base.length),
    }).toString();
    expect(body.length).toBe(BODY_LIMIT_BYTES.featured + 1024);
    expect(body.length).toBeGreaterThan(256 * 1024);
    const response = await app.request("/featured", { ...postForm(cookie, FORM), body }, bindings);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(ERROR);
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.sql).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoStoreWork();
  });
});

describe("controls: today's behavior outside the oversized-moderator case", () => {
  it.each(featuredPosts)(
    "%s: guest is still refused by the guard first, oversized or not, spending no throttle",
    async (_label, path, cap) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(null, throttle);
      const under = await app.request(path, postForm(cookie, FORM), bindings);
      expect(under.status).toBe(401);
      const { request, pull } = oversized(cookie, path, cap, true);
      const over = await app.request(request, undefined, bindings);
      expect(over.status).toBe(401);
      expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each(featuredPosts)(
    "%s: non-moderator is still 403 first, oversized or not, spending no throttle",
    async (_label, path, cap) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MEMBER, throttle);
      expect((await app.request(path, postForm(cookie, FORM), bindings)).status).toBe(403);
      const { request, pull } = oversized(cookie, path, cap, true);
      const over = await app.request(request, undefined, bindings);
      expect(over.status).toBe(403);
      expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoStoreWork();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each(featuredPosts)(
    "%s: moderator valid under-cap post still spends exactly one admin-write hit and saves",
    async (label, path) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const response = await app.request(path, postForm(cookie, FORM), bindings);
      expect(response.status).toBe(303);
      expect(throttle.count()).toBe(1);
      expect(
        throttle.buckets.some((v) => typeof v === "string" && v.startsWith("admin-write:")),
      ).toBe(true);
      if (label === "create") {
        expect(response.headers.get("location")).toBe(`/admin/featured/${ID}`);
        expect(createFeatured).toHaveBeenCalledOnce();
        expect(deleteFeatured).not.toHaveBeenCalled();
      } else {
        expect(response.headers.get("location")).toBe("/admin/featured");
        expect(deleteFeatured).toHaveBeenCalledOnce();
        expect(vi.mocked(deleteFeatured).mock.calls[0]?.[2]).toBe(ID);
        expect(createFeatured).not.toHaveBeenCalled();
      }
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it("create: moderator invalid under-cap post is still a 422 after exactly one throttle hit, with no save", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request(
      "/featured",
      postForm(cookie, { ...FORM, title: "" }),
      bindings,
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('data-testid="form-errors"');
    expect(throttle.count()).toBe(1);
    expectNoStoreWork();
  });

  it("delete: moderator malformed-id under-cap post is still a 404 after exactly one throttle hit, with no delete", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const response = await app.request(
      "/featured/not-an-id/delete",
      postForm(cookie, FORM),
      bindings,
    );
    expect(response.status).toBe(404);
    expect(throttle.count()).toBe(1);
    expectNoStoreWork();
  });

  it.each(featuredPosts)(
    "%s: a body of exactly the route cap is not a 413 and spends one hit",
    async (_label, path, cap) => {
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const base = new URLSearchParams({ ...FORM, pad: "" }).toString();
      const body = new URLSearchParams({
        ...FORM,
        pad: "x".repeat(cap - base.length),
      }).toString();
      expect(body.length).toBe(cap);
      const response = await app.request(path, { ...postForm(cookie, FORM), body }, bindings);
      expect(response.status).not.toBe(413);
      expect(throttle.count()).toBe(1);
    },
  );

  it.each(featuredPosts)(
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
