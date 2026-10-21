// Protected acceptance tests: the paired builder must leave this file unchanged.
// Admin no-DB writes need the admin recovery shell; malformed multipart needs
// negotiated 400 rather than bare text or 500. Real guards/body parsing/renderers,
// memory sessions and store-boundary doubles only: no SQL, sockets or live data.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  createEvent,
  createFeatured,
  deleteFeatured,
  getEvent,
  getFeatured,
  setRsvpOpen,
  transitionEvent,
  updateEvent,
  updateFeatured,
} from "../src/admin/store";
import type { events, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

vi.mock("postgres", () => ({
  default: () => {
    throw new Error("acceptance fixtures must not open a database");
  },
}));
vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  getEvent: vi.fn(),
  getFeatured: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  transitionEvent: vi.fn(),
  setRsvpOpen: vi.fn(),
  createFeatured: vi.fn(),
  updateFeatured: vi.fn(),
  deleteFeatured: vi.fn(),
}));

const BROWSER = "text/html,application/xhtml+xml";
const KEY = "fixture-event";
const PRIVATE = "private admin fixture details";
const event = {
  id: 1,
  eventKey: KEY,
  title: PRIVATE,
  game: "Chess",
  description: PRIVATE,
  location: "Voice",
  timezone: "UTC",
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
const featured = {
  id: 7,
  legacyId: null,
  title: PRIVATE,
  body: PRIVATE,
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
const dbTouched = vi.fn(() => {
  throw new Error("fixture must not query SQL");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;
const writes = [
  createEvent,
  updateEvent,
  transitionEvent,
  setRsvpOpen,
  createFeatured,
  updateFeatured,
  deleteFeatured,
];
const paths = [
  "/admin/events",
  `/admin/events/${KEY}`,
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map(
    (action) => `/admin/events/${KEY}/${action}`,
  ),
  "/admin/featured",
  "/admin/featured/7",
  "/admin/featured/7/delete",
];
const malformedPaths = [
  "/admin/events",
  `/admin/events/${KEY}`,
  "/admin/featured",
  "/admin/featured/7",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(event);
  vi.mocked(getFeatured).mockResolvedValue({ ...featured, startsAtText: null, endsAtText: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("fixture must remain offline"))),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(dbTouched).not.toHaveBeenCalled();
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function post(path: string, accept: string, withDb: boolean) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MODERATOR);
  const app = new Hono<{ Bindings: Env }>();
  app.route("/admin", adminApp({ sessionStore: sessions }));
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        cookie,
        origin: env.APP_URL,
        accept,
        "content-type": "multipart/form-data; boundary=fixture-boundary",
      },
      body: "malformed multipart " + PRIVATE,
    },
    { ...env, ...(withDb ? { ADMIN_DB: db } : {}) } as Env,
  );
}

function privateNoStore(response: Response) {
  expect(
    response.headers
      .get("cache-control")
      ?.split(",")
      .map((s) => s.trim())
      .sort(),
  ).toEqual(["no-store", "private"]);
}

describe("every no-DB admin write refuses in the admin shell for browsers", () => {
  it.each(paths)(
    "%s answers 503 with dashboard recovery before parsing/reading/writing",
    async (path) => {
      const response = await post(path, BROWSER, false);
      expect(response.status).toBe(503);
      expect(getEvent).not.toHaveBeenCalled();
      expect(getFeatured).not.toHaveBeenCalled();
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toContain("TWO admin");
      expect(body).toContain('aria-label="Administration"');
      expect(body).toContain('href="/admin"');
      expect(body).toContain("Back to the dashboard");
      expect(body).not.toContain(PRIVATE);
      privateNoStore(response);
    },
  );

  it.each(paths)("%s retains the machine caller's existing 503 bytes", async (path) => {
    const response = await post(path, "application/json", false);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Admin temporarily unavailable");
    expect(getEvent).not.toHaveBeenCalled();
    expect(getFeatured).not.toHaveBeenCalled();
    privateNoStore(response);
  });
});

describe("malformed admin multipart refuses before any write", () => {
  it.each(malformedPaths)("%s gives browsers a branded 400 recovery page", async (path) => {
    const response = await post(path, BROWSER, true);
    expect(response.status).toBe(400);
    if (path === `/admin/events/${KEY}`)
      expect(getEvent).toHaveBeenCalledWith(expect.anything(), KEY);
    if (path === "/admin/featured/7")
      expect(getFeatured).toHaveBeenCalledWith(expect.anything(), 7);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Check your request");
    expect(body).toContain('id="error-heading"');
    expect(body).toContain('href="/"');
    expect(body).not.toContain(PRIVATE);
    privateNoStore(response);
  });

  it.each(malformedPaths)("%s gives JSON callers the static bad_request envelope", async (path) => {
    const response = await post(path, "application/json", true);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "bad_request", message: expect.any(String) });
    privateNoStore(response);
  });
});
