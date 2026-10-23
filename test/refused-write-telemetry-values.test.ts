// route-inventory: PATCH /members/:user
// route-inventory: POST /events
// route-inventory: GET /discord
// Builder-owned exact-value pins for refused-write and invite-config telemetry.
//
// The paired acceptance file pins shapes only: line names and values are the
// Builder's choice there. This file pins the exact exception classes and the
// exact invite-alert fingerprint so a wrong-class or wrong-route regression
// fails here instead of hiding behind a shape assertion.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import {
  createEvent,
  getEvent,
  mergePatchInput,
  patchEvent,
  updateEvent,
} from "../src/admin/store";
import type { EventFormInput } from "../src/admin/validation";
import { dispatchWriteBack } from "../src/admin/writeback";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { FALLBACK_INVITE } from "../src/invite";
import { profilesApp } from "../src/profiles/routes";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  patchEvent: vi.fn(),
  updateEvent: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
}));
vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));
// The harnesses have no throttle store; keep the (separately-logged) fail-open
// throttle warn out of the refused-write line counts.
vi.mock("../src/throttle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/throttle")>()),
  throttle: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const USER_ID = "111111111111111111";

const PROFILE_MARKER = "values-pin-profile-probe-2b7e41";
const EVENT_MARKER = "values-pin-event-probe-8d1f09";
const INVITE_MARKER = "values-pin-invite-probe-5a6c33";

type ConsoleCall = unknown[];

const fieldsOf = (call: ConsoleCall): Record<string, unknown> | null => {
  const fields = call[1];
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  return fields as Record<string, unknown>;
};

const isAlertLine = (call: ConsoleCall): boolean => {
  if (typeof call[0] !== "string" || !call[0].startsWith("{")) return false;
  try {
    return (JSON.parse(call[0]) as { event?: unknown })?.event === "error.alert";
  } catch {
    return false;
  }
};

const isShedLine = (call: ConsoleCall): boolean => {
  const fields = fieldsOf(call);
  return !!fields && typeof fields.dropped === "number";
};

function captured(
  warn: ReturnType<typeof vi.spyOn>,
  error: ReturnType<typeof vi.spyOn>,
): { alerts: ConsoleCall[]; sheds: ConsoleCall[]; fires: ConsoleCall[] } {
  const all = [...warn.mock.calls, ...error.mock.calls] as ConsoleCall[];
  const alerts = all.filter(isAlertLine);
  const sheds = all.filter((call) => !isAlertLine(call) && isShedLine(call));
  const fires = all.filter((call) => !isAlertLine(call) && !isShedLine(call));
  return { alerts, sheds, fires };
}

function expectLeakFree(calls: ConsoleCall[], forbidden: string[]): void {
  const blob = JSON.stringify(calls);
  for (const needle of forbidden) expect(blob, `leaked ${needle}`).not.toContain(needle);
}

let now = Date.now();

beforeEach(() => {
  now += 600_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const warnSpy = () => vi.mocked(console.warn);
const errorSpy = () => vi.mocked(console.error);

// ---------------------------------------------------------------------------
// Profile leg: well-formed non-object JSON warns TypeError on its 400.
// ---------------------------------------------------------------------------

const profileEnv = { APP_URL, SESSION_SECRET } as Env;
const MALFORMED_PROFILE_JSON = `{"bio":"${PROFILE_MARKER} bio",`;

async function ownerCookie(sessions: ReturnType<typeof createMemorySessionStore>): Promise<{
  cookie: string;
  token: string;
}> {
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: USER_ID,
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, { path: "/", secure: true })
  ).split(";")[0]!;
  return { cookie, token };
}

function profileFixture(sessions: ReturnType<typeof createMemorySessionStore>) {
  const throttle = vi.fn(async (_bucket: string) => ({ limited: false }) as const);
  const store = {
    find: vi.fn(async () => ({
      id: USER_ID,
      username: "member",
      avatar: null,
      bio: null,
      games: [],
      timezone: null,
    })),
    save: vi.fn(async () => {}),
  };
  return { profile: profilesApp({ sessionStore: sessions, throttle, store }), throttle, store };
}

async function patchProfile(
  profile: ReturnType<typeof profileFixture>["profile"],
  cookie: string,
  body: BodyInit,
  contentType: string,
): Promise<Response> {
  return profile.request(
    `/members/${USER_ID}`,
    {
      method: "PATCH",
      body,
      headers: { cookie, origin: APP_URL, accept: "application/json", "content-type": contentType },
    },
    profileEnv,
  );
}

describe("profile refused-write telemetry values", () => {
  it.each([
    ["array", "[1,2]"],
    ["string", JSON.stringify("str")],
    ["number", "123"],
    ["null", "null"],
    ["boolean", "true"],
  ])("non-object JSON %s warns TypeError once and keeps the exact 400", async (_label, body) => {
    const sessions = createMemorySessionStore();
    const { cookie, token } = await ownerCookie(sessions);
    const { profile, store } = profileFixture(sessions);
    const res = await patchProfile(profile, cookie, body, "application/json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "bad_request",
      message: "Check your request and try again.",
    });
    expect(store.save).not.toHaveBeenCalled();
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(0);
    expect(sheds).toHaveLength(0);
    expect(fires).toHaveLength(1);
    expect(fires[0]![0]).toBe("profile.write.malformed_body");
    expect(fieldsOf(fires[0]!)).toMatchObject({
      exception: "TypeError",
      content_type: "application/json",
    });
    expectLeakFree([fires[0]!], [token, SESSION_SECRET, USER_ID, body]);
  });

  it("malformed profile JSON warns SyntaxError once and keeps the exact 400", async () => {
    const sessions = createMemorySessionStore();
    const { cookie, token } = await ownerCookie(sessions);
    const { profile, store } = profileFixture(sessions);
    const res = await patchProfile(profile, cookie, MALFORMED_PROFILE_JSON, "application/json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "bad_request",
      message: "Check your request and try again.",
    });
    expect(store.save).not.toHaveBeenCalled();
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(0);
    expect(sheds).toHaveLength(0);
    expect(fires).toHaveLength(1);
    expect(fires[0]![0]).toBe("profile.write.malformed_body");
    expect(fieldsOf(fires[0]!)).toMatchObject({
      exception: "SyntaxError",
      content_type: "application/json",
    });
    expectLeakFree([fires[0]!], [PROFILE_MARKER, MALFORMED_PROFILE_JSON, token, SESSION_SECRET]);
  });
});

// ---------------------------------------------------------------------------
// Event leg: exact exception classes for non-object and malformed JSON.
// ---------------------------------------------------------------------------

const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const eventRow = {
  id: 1,
  eventKey: EVENT_KEY,
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

const eventEnv: EnvWithAdminDb = {
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

const eventApp = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  eventApp,
  async () => moderator,
  async () => moderator,
);

function savedEvent(input: EventFormInput): typeof events.$inferSelect {
  const { startsAtUtc, endsAtUtc, ...fields } = input;
  return { ...eventRow, ...fields, startsAt: startsAtUtc, endsAt: endsAtUtc };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(eventRow);
  vi.mocked(createEvent).mockImplementation(async (_db, _actor, input) => ({
    row: savedEvent(input),
    writeBack: null,
  }));
  vi.mocked(patchEvent).mockImplementation(async (_db, _actor, _key, patch) => {
    const updated = savedEvent(mergePatchInput(eventRow, patch));
    vi.mocked(getPublicEvent).mockResolvedValue({ ...updated, goingCount: 0, goingOccupancy: 0 });
    return {
      row: updated,
      writeBack: { eventKey: EVENT_KEY, status: "published" },
      childWriteBacks: [],
    };
  });
});

async function postEvent(body: BodyInit, contentType: string): Promise<Response> {
  return eventApp.request(
    "/events",
    { method: "POST", headers: { "content-type": contentType }, body },
    eventEnv,
  );
}

function expectNoEventMutationOrDispatch(): void {
  expect(createEvent).not.toHaveBeenCalled();
  expect(patchEvent).not.toHaveBeenCalled();
  expect(updateEvent).not.toHaveBeenCalled();
  expect(getPublicEvent).not.toHaveBeenCalled();
  expect(dispatchWriteBack).not.toHaveBeenCalled();
}

const MALFORMED_EVENT_JSON = `{"title":"${EVENT_MARKER} title",`;
const EVENT_FORBIDDEN = [EVENT_MARKER, MALFORMED_EVENT_JSON, moderator.id];

describe("event refused-write telemetry values", () => {
  it.each([
    ["array", "[]"],
    ["string", JSON.stringify("e")],
    ["null", "null"],
  ])("non-object JSON %s warns TypeError once and keeps the exact 422", async (_label, body) => {
    const res = await postEvent(body, "application/json");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { body: "Send a JSON object." },
    });
    expectNoEventMutationOrDispatch();
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(0);
    expect(sheds).toHaveLength(0);
    expect(fires).toHaveLength(1);
    expect(fires[0]![0]).toBe("event.write.malformed_body");
    expect(fieldsOf(fires[0]!)).toMatchObject({
      exception: "TypeError",
      content_type: "application/json",
    });
    expectLeakFree([fires[0]!], [...EVENT_FORBIDDEN, body]);
  });

  it("malformed event JSON warns SyntaxError once and keeps the exact 422", async () => {
    const res = await postEvent(MALFORMED_EVENT_JSON, "application/json");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: { body: "Send a JSON object." },
    });
    expectNoEventMutationOrDispatch();
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(0);
    expect(sheds).toHaveLength(0);
    expect(fires).toHaveLength(1);
    expect(fires[0]![0]).toBe("event.write.malformed_body");
    expect(fieldsOf(fires[0]!)).toMatchObject({
      exception: "SyntaxError",
      content_type: "application/json",
    });
    expectLeakFree([fires[0]!], EVENT_FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------
// Invite leg: the /discord alert carries the exact fingerprint and route.
// ---------------------------------------------------------------------------

const BROKEN_INVITE = `https://discord.gg.evil.test/${INVITE_MARKER}`;
const INVITE_FORBIDDEN = [INVITE_MARKER, BROKEN_INVITE];

const discordEnv = (configured: string): Env =>
  ({
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: configured,
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
  }) as Env;

describe("invite-config telemetry values", () => {
  it("pins the exact InviteConfigError@/discord alert values", async () => {
    const res = await app.request("/discord", {}, discordEnv(BROKEN_INVITE));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(sheds).toHaveLength(0);
    expect(fires).toHaveLength(1);
    expect(fires[0]![0]).toBe("invite.config.unusable");
    expect(fieldsOf(fires[0]!)).toMatchObject({ exception: "InviteConfigError" });
    expect(alerts).toHaveLength(1);
    const line = JSON.parse(alerts[0]![0] as string) as Record<string, unknown>;
    expect(line.event).toBe("error.alert");
    expect(line.fingerprint).toBe("InviteConfigError@/discord");
    expect(line.exception).toBe("InviteConfigError");
    expect(line.error_class).toBe("InviteConfigError");
    expect(line.method).toBe("GET");
    expect(line.route).toBe("/discord");
    expectLeakFree([[alerts[0]![0]], fires[0]!], INVITE_FORBIDDEN);
  });
});
