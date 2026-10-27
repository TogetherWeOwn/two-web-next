// route-inventory: POST /admin/events
// Schedule-preview admission: forms, guards and zero-effect proofs.
//
// Both new-event forms carry the native Preview schedule submit; the preview
// POST reuses the Hono-owned POST /admin/events admission (moderator guard,
// same-origin, body cap before throttle, no-store) and performs zero store,
// write-back or cache-retirement calls. Hermetic: in-memory sessions, a
// counting throttle Sql double, store/writeback/cache spies and a
// fail-if-touched Db double; no DATABASE_URL, no sockets.
// Run: npx vitest run test/admin-event-schedule-preview-admission.test.ts
//
// On the pre-preview implementation the preview-markup and preview-200 cases
// fail (no button, no panel, createEvent called); the refusal, cap, throttle
// and create/update controls pass and pin today's admission in place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { createEvent, getEvent, recordAccess, updateEvent } from "../src/admin/store";
import { dispatchWriteBack } from "../src/admin/writeback";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { retireAnonEventCaches } from "../src/events/anon-cache";
import { retireHomeGuestCache } from "../src/home-cache";
import { retireApiPublicEventCache } from "../src/public-data/cache";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import {
  assertPreviewButtonMarkup,
  expectCreateFormIntact,
  expectPreviewPanel,
  previewSection,
  previewValues,
  SCHEDULE_PREVIEW_BASE_FORM,
  textOf,
} from "./helpers/schedule-preview-contract";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  recordAccess: vi.fn(),
}));
vi.mock("../src/admin/writeback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/writeback")>()),
  dispatchWriteBack: vi.fn(),
}));
vi.mock("../src/events/anon-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/anon-cache")>()),
  retireAnonEventCaches: vi.fn(),
}));
vi.mock("../src/home-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/home-cache")>()),
  retireHomeGuestCache: vi.fn(),
}));
vi.mock("../src/public-data/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/public-data/cache")>()),
  retireApiPublicEventCache: vi.fn(),
}));

// Reused literal already in the repo (no new secret-shaped strings).
const KEY = "01J0000000000000000000ABCD";
const MAX = BODY_LIMIT_BYTES.form;

const KIT_NEW_SOURCE = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/events/new/+page.svelte", import.meta.url).href),
  "utf8",
);

const row = {
  id: 1,
  eventKey: KEY,
  title: "Sunday Squad",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  timezone: "Europe/London",
  capacity: 8,
  startsAt: new Date("2026-10-04T19:00:00.000Z"),
  endsAt: new Date("2026-10-04T20:00:00.000Z"),
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
// (the spies above are the only sanctioned store seam).
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
  const app = new Hono<{ Bindings: EnvWithThrottle }>()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: sessions, db }));
  const bindings = {
    ...env,
    ADMIN_DB: db,
    THROTTLE_STORE: throttle.store,
  } as unknown as EnvWithThrottle;
  return { app, cookie, bindings };
}

function postForm(cookie: string, values: Record<string, string>, origin = env.APP_URL) {
  return {
    method: "POST" as const,
    headers: {
      cookie,
      origin,
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values).toString(),
  };
}

function expectNoPreviewEffects() {
  expect(getEvent).not.toHaveBeenCalled();
  expect(createEvent).not.toHaveBeenCalled();
  expect(updateEvent).not.toHaveBeenCalled();
  expect(dispatchWriteBack).not.toHaveBeenCalled();
  expect(retireAnonEventCaches).not.toHaveBeenCalled();
  expect(retireHomeGuestCache).not.toHaveBeenCalled();
  expect(retireApiPublicEventCache).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(row);
  vi.mocked(createEvent).mockResolvedValue({ row, writeBack: null });
  vi.mocked(updateEvent).mockResolvedValue({ row, writeBack: null, childWriteBacks: [] });
  vi.mocked(recordAccess).mockResolvedValue(true);
});

describe("PG01/PC03: the Hono new-event form offers preview beside create", () => {
  it("PG01: a native Preview schedule submit posts to the Hono-owned create path", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const res = await app.request("/admin/events/new", { headers: { cookie } }, bindings);
    expect(res.status).toBe(200);
    const html = await res.text();
    const formAt = html.indexOf("<form");
    expect(formAt).toBeGreaterThanOrEqual(0);
    expect(html).toContain('action="/admin/events"');
    expect(html.slice(formAt, formAt + 500)).not.toContain("onsubmit");
    assertPreviewButtonMarkup(html);
    expect(html.indexOf('data-testid="preview-schedule"')).toBeGreaterThan(formAt);
    expect(throttle.count()).toBe(0);
  });

  it("PC03: Create draft stays, and a fresh form previews nothing", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const html = await (
      await app.request("/admin/events/new", { headers: { cookie } }, bindings)
    ).text();
    expect(html).toContain('data-testid="save-event"');
    expect(html).toContain("Create draft");
    expect(previewSection(html)).toBeNull();
  });
});

describe("PG02: the Kit new-event form matches the Hono preview contract", () => {
  it("posts the same native preview submit to the Hono-owned create endpoint", () => {
    expect(KIT_NEW_SOURCE).toContain('action="/admin/events"');
    assertPreviewButtonMarkup(KIT_NEW_SOURCE);
  });

  it("keeps the create submit with no framework handlers on either submit", () => {
    expect(KIT_NEW_SOURCE).toContain('data-testid="save-event"');
    expect(KIT_NEW_SOURCE).toContain("Create draft");
    expect(KIT_NEW_SOURCE).not.toMatch(/on:[a-z]+=/);
    expect(KIT_NEW_SOURCE).not.toContain("onclick");
  });
});

describe("PG03-PG05: preview keeps the moderator admission", () => {
  it("PG03: a guest preview bounces to session recovery with zero throttle spend and zero effects", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(null, throttle);
    const res = await app.request(
      "/admin/events",
      postForm(cookie, previewValues({ recurrence_frequency: "weekly", recurrence_count: "4" })),
      bindings,
    );
    // Guest writes never re-submit: the shared expired-write bounce lands on
    // the GET form page via the recovery interstitial (write-recovery.tsx).
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fnew");
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoPreviewEffects();
  });

  it("PG04: a signed non-moderator preview is 403 with zero throttle spend and zero effects", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MEMBER, throttle);
    const res = await app.request(
      "/admin/events",
      postForm(cookie, previewValues({ recurrence_frequency: "weekly", recurrence_count: "4" })),
      bindings,
    );
    expect(res.status).toBe(403);
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoPreviewEffects();
  });

  it("PG05: a cross-origin preview is 403 with zero throttle spend and zero effects", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const res = await app.request(
      "/admin/events",
      postForm(
        cookie,
        previewValues({ recurrence_frequency: "weekly", recurrence_count: "4" }),
        "https://evil.example",
      ),
      bindings,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(0);
    expectNoPreviewEffects();
  });
});

describe("PG06-PG07: preview keeps the body cap and the shared throttle", () => {
  it("PG06: an oversized preview body is 413 with zero throttle spend and zero effects", async () => {
    // Advertised: a genuine preview-shaped form one byte over the form cap.
    {
      vi.clearAllMocks();
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const fields = previewValues({
        recurrence_frequency: "weekly",
        recurrence_count: "4",
      });
      const base = new URLSearchParams({ ...fields, pad: "" }).toString();
      const body = new URLSearchParams({
        ...fields,
        pad: "x".repeat(MAX + 1 - base.length),
      }).toString();
      expect(body.length).toBe(MAX + 1);
      const res = await app.request(
        "/admin/events",
        {
          ...postForm(cookie, fields),
          headers: {
            ...postForm(cookie, fields).headers,
            "content-length": String(body.length),
          },
          body,
        },
        bindings,
      );
      expect(res.status).toBe(413);
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoPreviewEffects();
    }
    // Streamed: garbage past the cap refuses without reading the tail.
    {
      vi.clearAllMocks();
      const throttle = throttleFixture(0);
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array(1024)),
      );
      const request = new Request(new URL("/admin/events", env.APP_URL), {
        method: "POST",
        body: new ReadableStream({ pull }, { highWaterMark: 0 }),
        duplex: "half",
        headers: {
          origin: env.APP_URL,
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
      } as RequestInit);
      const res = await app.request(request, undefined, bindings);
      expect(res.status).toBe(413);
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expectNoPreviewEffects();
      expect(pull.mock.calls.length).toBeLessThanOrEqual(MAX / 1024 + 2);
      await request.body?.cancel().catch(() => {});
    }
  });

  it("PG07: a preview under a spent budget is 429 with zero effects", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const res = await app.request(
      "/admin/events",
      postForm(cookie, previewValues({ recurrence_frequency: "weekly", recurrence_count: "4" })),
      bindings,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expectNoPreviewEffects();
  });
});

describe("PG08-PG10: a preview renders without any write", () => {
  it("PG08: a weekly preview spends one throttle hit and calls no writer, audit or cache seam", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const submitted = previewValues({
      recurrence_frequency: "weekly",
      recurrence_count: "4",
    });
    const res = await app.request("/admin/events", postForm(cookie, submitted), bindings);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expectPreviewPanel(html, submitted);
    expectCreateFormIntact(html, submitted);
    expect(throttle.count()).toBe(1);
    expect(
      throttle.buckets.some((v) => typeof v === "string" && v.startsWith("admin-write:")),
    ).toBe(true);
    expectNoPreviewEffects();
  });

  it("PG09: a one-off preview names its single meeting and calls no writer seam", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const submitted = previewValues({});
    const res = await app.request("/admin/events", postForm(cookie, submitted), bindings);
    expect(res.status).toBe(200);
    const html = await res.text();
    expectPreviewPanel(html, submitted);
    expect(textOf(html)).toMatch(/1 occurrence(?!s)/);
    expect(throttle.count()).toBe(1);
    expectNoPreviewEffects();
  });

  it("PG10: an invalid preview is a 422 with errors, no panel and zero effects", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const submitted = previewValues({
      recurrence_frequency: "weekly",
      recurrence_count: "53",
    });
    const res = await app.request("/admin/events", postForm(cookie, submitted), bindings);
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain('data-testid="form-errors"');
    expect(html).toContain('data-testid="error-recurrence_count"');
    expect(html).toContain("data-event-draft");
    expect(html).toContain("Create draft");
    expect(previewSection(html), "no stale successful output").toBeNull();
    expect(throttle.count()).toBe(1);
    expectNoPreviewEffects();
  });
});

describe("PC04-PC06: preview work preserves today's writes", () => {
  it("PC04: a valid create still spends one hit and saves through the store once", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const res = await app.request(
      "/admin/events",
      postForm(cookie, { ...SCHEDULE_PREVIEW_BASE_FORM }),
      bindings,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/events/${KEY}`);
    expect(throttle.count()).toBe(1);
    expect(createEvent).toHaveBeenCalledOnce();
    expect(getEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
    expect(dispatchWriteBack).not.toHaveBeenCalled();
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it("PC05: preview and create stay native submits under the progressive islands", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const formHtml = await (
      await app.request("/admin/events/new", { headers: { cookie } }, bindings)
    ).text();
    for (const source of [formHtml, KIT_NEW_SOURCE]) {
      for (const testid of ["preview-schedule", "save-event"]) {
        const open = source.match(new RegExp(`<button\\b[^>]*data-testid="${testid}"[^>]*>`));
        expect(open, `${testid} is a native button`).not.toBeNull();
        expect(open![0]).toContain('type="submit"');
        expect(open![0]).not.toMatch(/on:[a-z]+=|onclick/i);
      }
    }
    expect(formHtml).toContain("/islands/admin-event-text-limits.js");
    expect(formHtml).toContain("/islands/admin-event-editor.js");
  });

  it("PC06: the update path ignores the preview discriminator, as today", async () => {
    const throttle = throttleFixture(0);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle);
    const res = await app.request(
      `/admin/events/${KEY}`,
      postForm(cookie, { ...SCHEDULE_PREVIEW_BASE_FORM, preview: "schedule" }),
      bindings,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/events/${KEY}`);
    expect(getEvent).toHaveBeenCalledOnce();
    expect(updateEvent).toHaveBeenCalledOnce();
    expect(createEvent).not.toHaveBeenCalled();
  });
});
