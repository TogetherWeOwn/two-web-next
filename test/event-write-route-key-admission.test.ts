// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: POST /events/:key/cancel
// route-inventory: POST /events/:key/rsvp-pause
// route-inventory: POST /events/:key/rsvp-reopen
// JSON sibling of the admin event route-key admission: PATCH /events/:key and
// the publish/cancel/rsvp-pause/rsvp-reopen transitions pass the decoded :key
// to the same store writers the HTML admin routes use, so they refuse
// malformed keys with the same eventKeyAllowed contract and the same 404
// not_found the other JSON event routes answer. The check sits after the
// moderator gate (guests still 401, non-moderators still 403) and before the
// first store call — and before body parsing on PATCH, so a malformed key
// with a malformed body still 404s instead of 422ing.
//
// Hermetic: the store writers, the public read-back and the write-back
// dispatch are test doubles, the session reader is injected, and ADMIN_DB is
// a proxy that throws if any SQL runs (same shape as
// test/event-write-malformed-form-body.test.ts). A refused key that reached
// the store would 500 instead of 404, and the writer spies would fire.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { NotFoundError, patchEvent, setRsvpOpen, transitionEvent } from "../src/admin/store";
import { dispatchWriteBack } from "../src/admin/writeback";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent, withGoingCount } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { STAGING_APP_URL } from "../src/qa";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  patchEvent: vi.fn(),
  transitionEvent: vi.fn(),
  setRsvpOpen: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
  withGoingCount: vi.fn(),
}));
vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const APP_URL = "https://next.example.test";
const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// ULID-length keys with a non-Crockford final char, built without retaining
// the high-entropy literal (a committed literal tripped the secrets scanner).
const nonCrockford = (tail: string) => VALID_ULID.slice(0, 25) + tail;

const row = {
  id: 1,
  eventKey: VALID_ULID,
  title: "Game night",
  game: "Chess",
  description: "Bring a board",
  location: "Voice",
  timezone: "Europe/London",
  capacity: 8,
  startsAt: new Date("2030-01-01T18:00:00Z"),
  endsAt: new Date("2030-01-01T19:00:00Z"),
  discordEventId: "123456789012345678",
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
  status: "published",
  rsvpOpen: false,
  createdBy: "event-moderator",
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies typeof events.$inferSelect;

const env: EnvWithAdminDb = {
  APP_URL,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture",
  ADMIN_DB: new Proxy({} as Db, {
    get: (_, key) => {
      if (key === "then") return undefined;
      throw new Error("fixture must not query a DB");
    },
  }),
};

const moderator: Session = {
  id: "event-moderator",
  username: "mod",
  avatar: null,
  member: true,
  moderator: true,
};

let currentSession: Session | null = moderator;
const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => currentSession,
  async () => currentSession,
);

const asPublic = { ...row, goingCount: 0, goingOccupancy: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  currentSession = moderator;
  vi.mocked(patchEvent).mockResolvedValue({ row, writeBack: null, childWriteBacks: [] });
  vi.mocked(transitionEvent).mockResolvedValue({ row, writeBack: null });
  vi.mocked(setRsvpOpen).mockResolvedValue({ row, writeBack: null });
  vi.mocked(getPublicEvent).mockResolvedValue(asPublic);
  vi.mocked(withGoingCount).mockResolvedValue(asPublic);
});

const patch = (segment: string, body = '{"title":"Renamed"}') =>
  app.request(
    `/events/${segment}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body },
    env,
  );

const act = (segment: string, action: "publish" | "cancel" | "rsvp-pause" | "rsvp-reopen") =>
  app.request(`/events/${segment}/${action}`, { method: "POST" }, env);

function expectWritersSilent() {
  expect(patchEvent).not.toHaveBeenCalled();
  expect(transitionEvent).not.toHaveBeenCalled();
  expect(setRsvpOpen).not.toHaveBeenCalled();
  expect(getPublicEvent).not.toHaveBeenCalled();
  expect(withGoingCount).not.toHaveBeenCalled();
  expect(dispatchWriteBack).not.toHaveBeenCalled();
}

// Path segments as they arrive on the wire; Hono decodes the :key param, so
// %00 reaches the handler as a real NUL and %2F as a slash inside the key.
const MALFORMED = [
  { label: "embedded NUL", segment: "AB%00CD" },
  { label: "NUL only", segment: "%00" },
  { label: "Non-Crockford I at ULID length", segment: nonCrockford("I") },
  { label: "Non-Crockford L at ULID length", segment: nonCrockford("L") },
  { label: "Non-Crockford O at ULID length", segment: nonCrockford("O") },
  { label: "Non-Crockford U at ULID length", segment: nonCrockford("U") },
  { label: "short key", segment: "abc" },
  { label: "25-char ULID prefix", segment: VALID_ULID.slice(0, 25) },
  { label: "27-char ULID plus one", segment: `${VALID_ULID}V` },
  { label: "oversized 300-char key", segment: "A".repeat(300) },
  { label: "encoded slash", segment: "AB%2FCD" },
  { label: "encoded space", segment: "AB%20CD" },
  { label: "encoded question mark", segment: "AB%3FCD" },
  { label: "punctuation", segment: "key!" },
] as const;

const SUBSET = [MALFORMED[0]!, MALFORMED[5]!, MALFORMED[9]!, MALFORMED[10]!];

describe("JSON event PATCH refuses malformed keys before the store", () => {
  it.each(MALFORMED)("PATCH $label: 404 not_found, writers silent", async ({ segment }) => {
    const res = await patch(segment);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expectWritersSilent();
  });

  it("malformed key with a malformed body still 404s (admission precedes parsing)", async () => {
    const res = await patch("AB%00CD", '{"title":');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expectWritersSilent();
  });
});

describe("JSON event transitions refuse malformed keys before the store", () => {
  for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
    it.each(SUBSET)(`POST ${action} $label: 404 not_found, writers silent`, async ({ segment }) => {
      const res = await act(segment, action);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expectWritersSilent();
    });
  }
});

describe("seed demo keys keep their exact allowance on JSON writes", () => {
  it("seed key on a production APP_URL refuses with silent writers", async () => {
    const res = await patch("seed-calendar-01");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expectWritersSilent();
  });

  it("seed key on staging is admitted to the writer", async () => {
    const res = await app.request(
      "/events/seed-calendar-01",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      { ...env, APP_URL: STAGING_APP_URL },
    );
    expect(res.status).toBe(200);
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(patchEvent).mock.calls[0]![2]).toBe("seed-calendar-01");
  });
});

describe("admitted keys and the guard keep today's behaviour (controls)", () => {
  it("valid ULID PATCH reaches the writer with the key unchanged", async () => {
    const res = await patch(VALID_ULID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { title: "Game night" } });
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(patchEvent).mock.calls[0]![2]).toBe(VALID_ULID);
  });

  it("valid ULID publish reaches the transition with the key unchanged", async () => {
    const res = await act(VALID_ULID, "publish");
    expect(res.status).toBe(200);
    expect(transitionEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transitionEvent).mock.calls[0]!.slice(2)).toEqual([VALID_ULID, "published"]);
  });

  it("valid ULID cancel reaches the transition with the key unchanged", async () => {
    const res = await act(VALID_ULID, "cancel");
    expect(res.status).toBe(200);
    expect(transitionEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transitionEvent).mock.calls[0]!.slice(2)).toEqual([VALID_ULID, "cancelled"]);
  });

  it("valid ULID rsvp-pause reaches setRsvpOpen closing availability", async () => {
    const res = await act(VALID_ULID, "rsvp-pause");
    expect(res.status).toBe(200);
    expect(setRsvpOpen).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setRsvpOpen).mock.calls[0]!.slice(2)).toEqual([VALID_ULID, false]);
  });

  it("valid ULID rsvp-reopen reaches setRsvpOpen opening availability", async () => {
    const res = await act(VALID_ULID, "rsvp-reopen");
    expect(res.status).toBe(200);
    expect(setRsvpOpen).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setRsvpOpen).mock.calls[0]!.slice(2)).toEqual([VALID_ULID, true]);
  });

  it("valid unknown ULID still refuses through the store (writer 404, not the gate)", async () => {
    vi.mocked(patchEvent).mockRejectedValueOnce(new NotFoundError("missing"));
    const res = await patch(VALID_ULID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(patchEvent).toHaveBeenCalledTimes(1);
  });

  it("guests still 401 on a malformed key, writers silent", async () => {
    currentSession = null;
    const res = await app.request(`/events/AB%00CD`, { method: "PATCH" }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expectWritersSilent();
  });

  it("non-moderators still 403 on malformed keys, read and write, writers silent", async () => {
    currentSession = { ...moderator, moderator: false };
    const edit = await patch("AB%00CD");
    expect(edit.status).toBe(403);
    expect(await edit.json()).toEqual({ error: "forbidden" });
    const action = await act("AB%00CD", "publish");
    expect(action.status).toBe(403);
    expect(await action.json()).toEqual({ error: "forbidden" });
    expectWritersSilent();
  });
});
