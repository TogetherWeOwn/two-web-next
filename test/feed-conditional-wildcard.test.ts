// Hermetic feed requests exercise the real route/admission/response code; only
// reads are synthetic. No database, session store or network is contacted.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getEventRow, listFeed } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";

vi.mock("../src/events/reads", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/events/reads")>(),
  getEventRow: vi.fn(),
  listFeed: vi.fn(),
}));

const KEY = "01J0000000000000000000ABCD";
const EVENT_PATH = `/events/${KEY}.ics`;
const row = {
  id: 1, eventKey: KEY, title: "Synthetic calendar event", game: null,
  discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
  icsSequence: 1782907200n, syncRevision: 1, syncedRevision: 0,
  recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null,
  parentEventId: null, recurrenceIndex: null,
  description: "Bring stims.", startsAt: new Date("2026-07-15T18:00:00Z"),
  endsAt: new Date("2026-07-15T20:00:00Z"), timezone: "UTC", location: null,
  capacity: null, status: "published", rsvpOpen: true, createdBy: null,
  createdAt: new Date("2026-07-01T12:00:00Z"), updatedAt: new Date("2026-07-01T12:00:00Z"),
} satisfies typeof events.$inferSelect;
const dbIdentity = Symbol("fixture database");
const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture", DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture", DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture", SESSION_SECRET: "fixture",
  ADMIN_DB: new Proxy({} as Db, { get: (_, key) => {
    if (key === "then") return undefined;
    if (key === dbIdentity) return dbIdentity;
    throw new Error("fixture must not query a DB");
  } }),
};
const moderator: Session = { id: "fixture", username: "mod", avatar: null, member: true, moderator: true };
const readSession = vi.fn<() => Promise<Session | null>>();
const readFragmentSession = vi.fn<() => Promise<Session | null>>();
const app = new Hono<{ Bindings: Env }>();
app.onError(() => new Response("Synthetic read failure", { status: 500 }));
registerEventRoutes(app, readSession, readFragmentSession);
const req = (path: string, validator?: string, bindings = env) => app.request(path, {
  headers: validator === undefined ? {} : { "if-none-match": validator },
}, bindings);

beforeEach(() => {
  vi.resetAllMocks();
  // Pin the current empty-RSS clock without assuming the pending stability fix.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
  vi.mocked(listFeed).mockResolvedValue([row]);
  vi.mocked(getEventRow).mockResolvedValue(row);
  readSession.mockResolvedValue(null);
  readFragmentSession.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

async function expectNotModified(path: string, validator: string, baseline: Response) {
  const response = await req(path, validator);
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe(baseline.headers.get("etag"));
  expect(response.headers.get("cache-control")).toBe(baseline.headers.get("cache-control"));
  return response;
}

describe("successful public feeds accept the wildcard after reading the representation", () => {
  for (const path of ["/events.ics", "/events.rss"]) {
    it.each([false, true])(`${path}: wildcard with empty=%s`, async (empty) => {
      vi.mocked(listFeed).mockResolvedValue(empty ? [] : [row]);
      const baseline = await req(path);
      expect(baseline.status).toBe(200);
      const body = await baseline.text();
      expect(body.length).toBeGreaterThan(0);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
      expect(baseline.headers.get("etag")).toBe(etag);
      expect(baseline.headers.get("cache-control")).toBe("max-age=300, public");
      expect(baseline.headers.get("set-cookie")).toBeNull();
      for (const wildcard of ["*", " \t*\t "]) {
        const response = await expectNotModified(path, wildcard, baseline);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(listFeed).toHaveBeenCalledTimes(3);
      expect((vi.mocked(listFeed).mock.calls.at(-1)![0] as unknown as Record<symbol, unknown>)[dbIdentity]).toBe(dbIdentity);
      expect(vi.mocked(listFeed).mock.calls.at(-1)![1]).toEqual(path.endsWith(".rss") ? ["published"] : ["published", "cancelled"]);
      expect(readSession).not.toHaveBeenCalled();
      expect(readFragmentSession).not.toHaveBeenCalled();
    });
  }
});

describe("readable per-event ICS accepts the wildcard only after admission", () => {
  it.each(["published", "past", "cancelled", "draft"] as const)("%s representation", async (status) => {
    vi.mocked(getEventRow).mockResolvedValue({ ...row, status });
    readSession.mockResolvedValue(moderator);
    const baseline = await req(EVENT_PATH);
    expect(baseline.status).toBe(200);
    expect(baseline.headers.get("content-disposition")).toBe(`attachment; filename="${KEY}.ics"`);
    expect(baseline.headers.get("cache-control")).toBe("max-age=300, private");
    if (status === "cancelled") expect(await baseline.text()).toContain("STATUS:CANCELLED");
    await expectNotModified(EVENT_PATH, "*", baseline);
    expect(getEventRow).toHaveBeenCalledTimes(2);
    expect((vi.mocked(getEventRow).mock.calls.at(-1)![0] as unknown as Record<symbol, unknown>)[dbIdentity]).toBe(dbIdentity);
    expect(vi.mocked(getEventRow).mock.calls.at(-1)![1]).toBe(KEY);
    expect(readSession).toHaveBeenCalledTimes(status === "draft" ? 2 : 0);
    expect(readFragmentSession).not.toHaveBeenCalled();
  });
});

describe("ordinary strong, weak and list validators retain their existing behavior", () => {
  it.each(["/events.ics", "/events.rss", EVENT_PATH])("%s", async (path) => {
    const baseline = await req(path);
    const body = await baseline.text();
    const etag = baseline.headers.get("etag")!;
    for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, ` "other", W/${etag} `]) {
      await expectNotModified(path, validator, baseline);
    }
    // A wildcard is its own field value, not a quoted tag or a list member.
    for (const validator of ["", '"other"', 'W/"other", "another"', '"*"', "W/*", '"other", *']) {
      const response = await req(path, validator);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("cache-control")).toBe(baseline.headers.get("cache-control"));
      expect(response.headers.get("content-type")).toBe(baseline.headers.get("content-type"));
      expect(response.headers.get("content-disposition")).toBe(baseline.headers.get("content-disposition"));
    }
  });
});

describe("wildcards never replace a denial, missing representation or read failure", () => {
  it.each([null, { ...moderator, moderator: false }])("draft denied to %j", async (session) => {
    vi.mocked(getEventRow).mockResolvedValue({ ...row, status: "draft" });
    readSession.mockResolvedValue(session);
    const response = await req(EVENT_PATH, "*");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(response.headers.get("etag")).toBeNull();
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  it("missing event stays 404", async () => {
    vi.mocked(getEventRow).mockResolvedValue(null);
    const response = await req(EVENT_PATH, "*");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe("");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("malformed event key stays 404 without a read", async () => {
    expect((await req("/events/nope.ics", "*")).status).toBe(404);
    expect(getEventRow).not.toHaveBeenCalled();
  });

  it.each(["/events.ics", "/events.rss", EVENT_PATH])("%s: unavailable DB stays 503", async (path) => {
    const response = await req(path, "*", { ...env, ADMIN_DB: undefined });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Events temporarily unavailable");
    expect(response.headers.get("etag")).toBeNull();
    expect(listFeed).not.toHaveBeenCalled();
    expect(getEventRow).not.toHaveBeenCalled();
  });

  it.each(["/events.ics", "/events.rss", EVENT_PATH])("%s: thrown read stays 500", async (path) => {
    vi.mocked(listFeed).mockRejectedValue(new Error("synthetic read failure"));
    vi.mocked(getEventRow).mockRejectedValue(new Error("synthetic read failure"));
    const response = await req(path, "*");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Synthetic read failure");
    expect(response.headers.get("etag")).toBeNull();
  });
});
