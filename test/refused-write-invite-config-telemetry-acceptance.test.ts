// route-inventory: PATCH /members/:user
// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// route-inventory: GET /discord
// Acceptance: refused-write and invite-config telemetry.
//
// TEST AUTHOR CARD. The Builder builds on this branch and never edits this
// file; corrections return to the Test Author. This file is the whole handoff:
// it must RED on the current implementation (missing/broken telemetry) and go
// green once the build lands, with no other test file touched on this branch.
//
// Contract (from the paired build card):
//   FIRE (warn, rate-limited, class-only): malformed profile bodies (the 400
//     body-parse catch), malformed event JSON (422 "Send a JSON object.") and
//     form bodies (422 "Send a valid form body."), and broken invite config
//     (warn plus one request-error alert per window).
//   SILENT: valid writes, well-formed-but-invalid 422s (user errors, not
//     malformed bodies), 415s (admission refusal before the body is read, not
//     a malformed body), and the post-budget flood tail (exactly one shed line
//     per window instead of per-refusal warns).
//
// The Builder chooses the warn line names; these tests pin the shape instead:
//   - every fire line carries a fields object with a non-empty `exception`
//     class string (house convention, see the profile save failure and the CSP
//     sink_failed lines) and, on the write legs, the refused content-type as a
//     string value containing the bare media type;
//   - every field value is a scalar-or-null (fixed-key log lines; the raw body
//     must never reach the log nested, per the CSP precedent);
//   - the shed signal is the line whose fields carry a numeric `dropped >= 1`
//     (the csp.report.shed precedent: at most one shed warn per refill window,
//     counting log-budget drops so operators can tell shedding from quiet);
//   - the invite alert is one console.error JSON line with event "error.alert"
//     per window (alertRequestError shape: fingerprint, exception, method,
//     route); values are the Builder's choice, leaks are not.
// Leak rule: no marker, body byte, cookie/token, secret, configured invite
// value, or member identifier in any captured line on any leg.
// Hermetic: bare mounts plus in-memory stores, injected sessions, throwing
// ADMIN_DB proxies; no DATABASE_URL, no sockets. Floods of 80 assume the log
// bucket bursts below 80 (precedent: the CSP sink bursts 20).
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
import { ALERT_WINDOW_MS, __resetAlertRateLimitForTests } from "../src/alerts";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { FALLBACK_INVITE, inviteDestination } from "../src/invite";
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

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const USER_ID = "111111111111111111";
const FLOOD = 80;

const PROFILE_MARKER = "refused-profile-probe-7f3a91";
const EVENT_MARKER = "refused-event-probe-4c8d22";
const INVITE_MARKER = "refused-invite-probe-9e1b63";

// ---------------------------------------------------------------------------
// Console capture + line classification.
// ---------------------------------------------------------------------------

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
): { alerts: ConsoleCall[]; sheds: ConsoleCall[]; fires: ConsoleCall[]; all: ConsoleCall[] } {
  const all = [...warn.mock.calls, ...error.mock.calls] as ConsoleCall[];
  const alerts = all.filter(isAlertLine);
  const sheds = all.filter((call) => !isAlertLine(call) && isShedLine(call));
  const fires = all.filter((call) => !isAlertLine(call) && !isShedLine(call));
  return { alerts, sheds, fires, all };
}

function expectLeakFree(calls: ConsoleCall[], forbidden: string[]): void {
  const blob = JSON.stringify(calls);
  for (const needle of forbidden) expect(blob, `leaked ${needle}`).not.toContain(needle);
}

/** The fire-line shape: named line, fields object, exception class, scalars only. */
function expectFireShape(
  call: ConsoleCall,
  opts: { mediaType?: string; forbidden: string[] },
): void {
  expect(typeof call[0], `fire line needs a name: ${JSON.stringify(call)}`).toBe("string");
  expect((call[0] as string).length).toBeGreaterThan(0);
  const fields = fieldsOf(call);
  expect(fields, `fire line must carry a fields object: ${JSON.stringify(call)}`).not.toBeNull();
  expect(typeof fields!.exception).toBe("string");
  expect((fields!.exception as string).length).toBeGreaterThan(0);
  if (opts.mediaType) {
    const carriesMediaType = Object.values(fields!).some(
      (value) => typeof value === "string" && value.includes(opts.mediaType!),
    );
    expect(
      carriesMediaType,
      `fire line must carry the refused content-type: ${JSON.stringify(call)}`,
    ).toBe(true);
  }
  for (const [key, value] of Object.entries(fields!)) {
    const scalar = ["string", "number", "boolean"].includes(typeof value) || value === null;
    expect(scalar, `field ${key} must be scalar-or-null, never nested`).toBe(true);
  }
  expectLeakFree([call], opts.forbidden);
}

function expectShedShape(call: ConsoleCall, forbidden: string[]): void {
  expect(typeof call[0]).toBe("string");
  const fields = fieldsOf(call);
  expect(fields).not.toBeNull();
  expect(Number.isInteger(fields!.dropped)).toBe(true);
  expect(fields!.dropped as number).toBeGreaterThanOrEqual(1);
  for (const [key, value] of Object.entries(fields!)) {
    const scalar = ["string", "number", "boolean"].includes(typeof value) || value === null;
    expect(scalar, `shed field ${key} must be scalar-or-null`).toBe(true);
  }
  expectLeakFree([call], forbidden);
}

function expectAlertShape(raw: unknown, forbidden: string[]): void {
  expect(typeof raw).toBe("string");
  const line = JSON.parse(raw as string) as Record<string, unknown>;
  expect(line.event).toBe("error.alert");
  expect(typeof line.fingerprint).toBe("string");
  expect(line.fingerprint as string).toContain("@");
  expect(typeof line.exception).toBe("string");
  expect((line.exception as string).length).toBeGreaterThan(0);
  expect(typeof line.error_class).toBe("string");
  expect(typeof line.method).toBe("string");
  expect((line.method as string).length).toBeGreaterThan(0);
  expect(typeof line.route).toBe("string");
  expect((line.route as string).length).toBeGreaterThan(0);
  if (line.request_id !== undefined) expect(typeof line.request_id).toBe("string");
  expectLeakFree([[raw]], forbidden);
}

// ---------------------------------------------------------------------------
// Time control: refill every log bucket and age out every alert window between
// cases, never within a flood.
// ---------------------------------------------------------------------------

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
// Profile leg: PATCH /members/:user with an owner session.
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

describe("profile refused-write telemetry", () => {
  it("a malformed profile body warns once and keeps the exact 400 shape", async () => {
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
    expectFireShape(fires[0]!, {
      mediaType: "application/json",
      forbidden: [PROFILE_MARKER, MALFORMED_PROFILE_JSON, token, SESSION_SECRET, USER_ID],
    });
  });

  it("a profile flood warns bounded with exactly one shed and every refusal still 400", async () => {
    const sessions = createMemorySessionStore();
    const { cookie, token } = await ownerCookie(sessions);
    const { profile, store } = profileFixture(sessions);
    for (let i = 0; i < FLOOD; i += 1) {
      const res = await patchProfile(profile, cookie, MALFORMED_PROFILE_JSON, "application/json");
      expect(res.status).toBe(400);
    }
    expect(store.save).not.toHaveBeenCalled();
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(0);
    // Bounded: fewer warns than refusals, but the leg is not silent.
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires.length).toBeLessThan(FLOOD);
    expect(sheds).toHaveLength(1);
    const forbidden = [PROFILE_MARKER, MALFORMED_PROFILE_JSON, token, SESSION_SECRET, USER_ID];
    for (const fire of fires) expectFireShape(fire, { mediaType: "application/json", forbidden });
    expectShedShape(sheds[0]!, forbidden);
  });

  it("a second profile flood in the same window adds no lines; refill re-arms the warn", async () => {
    const sessions = createMemorySessionStore();
    const { cookie } = await ownerCookie(sessions);
    const { profile } = profileFixture(sessions);
    const refuse = async () => {
      const res = await patchProfile(profile, cookie, MALFORMED_PROFILE_JSON, "application/json");
      expect(res.status).toBe(400);
    };
    for (let i = 0; i < FLOOD; i += 1) await refuse();
    const first = captured(warnSpy(), errorSpy());
    expect(first.fires.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < FLOOD; i += 1) await refuse();
    const second = captured(warnSpy(), errorSpy());
    expect(second.all.length).toBe(first.all.length);
    now += 600_000;
    await refuse();
    const third = captured(warnSpy(), errorSpy());
    expect(third.all.length).toBeGreaterThan(second.all.length);
  });

  it("a valid profile save stays silent", async () => {
    const sessions = createMemorySessionStore();
    const { cookie } = await ownerCookie(sessions);
    const { profile, store } = profileFixture(sessions);
    const res = await patchProfile(
      profile,
      cookie,
      JSON.stringify({ bio: "valid save", games: [] }),
      "application/json",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(store.save).toHaveBeenCalledOnce();
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });

  it("a profile validation 422 on a well-formed body stays silent", async () => {
    const sessions = createMemorySessionStore();
    const { cookie } = await ownerCookie(sessions);
    const { profile, store } = profileFixture(sessions);
    const res = await patchProfile(
      profile,
      cookie,
      JSON.stringify({ bio: "x".repeat(1001), games: [] }),
      "application/json",
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      errors: { bio: "Keep your bio to 1000 characters or fewer." },
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });

  it("a profile 415 stays silent", async () => {
    const sessions = createMemorySessionStore();
    const { cookie } = await ownerCookie(sessions);
    const { profile, store } = profileFixture(sessions);
    const res = await patchProfile(profile, cookie, "bio=smuggled", "text/plain; charset=utf-8");
    expect(res.status).toBe(415);
    expect(store.save).not.toHaveBeenCalled();
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event leg: POST /events and PATCH /events/:key with an injected moderator.
// Same hermetic shape as test/event-write-malformed-form-body.test.ts: mocked
// store, mocked read-back, throwing ADMIN_DB proxy, no DATABASE_URL.
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

type EventMethod = "POST" | "PATCH";
const eventPath = (method: EventMethod) => (method === "POST" ? "/events" : `/events/${EVENT_KEY}`);

async function writeEvent(
  method: EventMethod,
  body: BodyInit,
  contentType: string,
): Promise<Response> {
  return eventApp.request(
    eventPath(method),
    { method, headers: { "content-type": contentType }, body },
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
const MALFORMED_EVENT_FORM = `garbage-${EVENT_MARKER}`;
const EVENT_FORBIDDEN = [EVENT_MARKER, MALFORMED_EVENT_JSON, MALFORMED_EVENT_FORM, moderator.id];

describe("event refused-write telemetry", () => {
  it.each(["POST", "PATCH"] as const)(
    "%s with a malformed JSON body warns once and keeps the exact 422 shape",
    async (method) => {
      const res = await writeEvent(method, MALFORMED_EVENT_JSON, "application/json");
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
      expectFireShape(fires[0]!, { mediaType: "application/json", forbidden: EVENT_FORBIDDEN });
    },
  );

  it.each(["POST", "PATCH"] as const)(
    "%s with a malformed form body warns once and keeps the exact 422 shape",
    async (method) => {
      const res = await writeEvent(method, MALFORMED_EVENT_FORM, "multipart/form-data; boundary=x");
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "invalid",
        fields: { body: "Send a valid form body." },
      });
      expectNoEventMutationOrDispatch();
      const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
      expect(alerts).toHaveLength(0);
      expect(sheds).toHaveLength(0);
      expect(fires).toHaveLength(1);
      expectFireShape(fires[0]!, {
        mediaType: "multipart/form-data",
        forbidden: EVENT_FORBIDDEN,
      });
    },
  );

  it("an event flood warns bounded with exactly one shed and every refusal still 422", async () => {
    for (let i = 0; i < FLOOD; i += 1) {
      const res = await writeEvent("POST", MALFORMED_EVENT_JSON, "application/json");
      expect(res.status).toBe(422);
    }
    expectNoEventMutationOrDispatch();
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(0);
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires.length).toBeLessThan(FLOOD);
    expect(sheds).toHaveLength(1);
    for (const fire of fires)
      expectFireShape(fire, { mediaType: "application/json", forbidden: EVENT_FORBIDDEN });
    expectShedShape(sheds[0]!, EVENT_FORBIDDEN);
  });

  it("a second event flood in the same window adds no lines; refill re-arms the warn", async () => {
    const refuse = async () => {
      const res = await writeEvent("POST", MALFORMED_EVENT_JSON, "application/json");
      expect(res.status).toBe(422);
    };
    for (let i = 0; i < FLOOD; i += 1) await refuse();
    const first = captured(warnSpy(), errorSpy());
    expect(first.fires.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < FLOOD; i += 1) await refuse();
    const second = captured(warnSpy(), errorSpy());
    expect(second.all.length).toBe(first.all.length);
    now += 600_000;
    await refuse();
    const third = captured(warnSpy(), errorSpy());
    expect(third.all.length).toBeGreaterThan(second.all.length);
  });

  it("a valid event PATCH stays silent", async () => {
    const form = new FormData();
    form.set("title", "Multipart edit");
    const res = await eventApp.request(
      eventPath("PATCH"),
      { method: "PATCH", body: form },
      eventEnv,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { title: string } }).data.title).toBe("Multipart edit");
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });

  it("an event validation 422 on a well-formed body stays silent", async () => {
    const res = await writeEvent("POST", JSON.stringify({}), "application/json");
    expect(res.status).toBe(422);
    expectNoEventMutationOrDispatch();
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });

  it("an event 415 stays silent", async () => {
    const res = await writeEvent("POST", "title=Smuggled", "text/plain; charset=utf-8");
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported_media_type" });
    expectNoEventMutationOrDispatch();
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invite leg: broken DISCORD_INVITE_URL warns rate-limited and fires the
// request-error alert once per window; fallback serving never changes.
// ---------------------------------------------------------------------------

const BROKEN_INVITE = `https://discord.gg.evil.test/${INVITE_MARKER}`;
const CREDENTIALED_INVITE = "https://synthetic-user:synthetic-password@discord.gg/Ab12";
const INVITE_FORBIDDEN = [INVITE_MARKER, BROKEN_INVITE, CREDENTIALED_INVITE, "synthetic-password"];

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

describe("invite-config telemetry", () => {
  it("a broken invite config warns once and still serves the fallback", async () => {
    expect(inviteDestination(BROKEN_INVITE)).toBe(FALLBACK_INVITE);
    expect(inviteDestination(CREDENTIALED_INVITE)).toBe(FALLBACK_INVITE);
    const { sheds, fires } = captured(warnSpy(), errorSpy());
    expect(sheds).toHaveLength(0);
    expect(fires).toHaveLength(2);
    for (const fire of fires) expectFireShape(fire, { forbidden: INVITE_FORBIDDEN });
  });

  it("an invite flood warns bounded with exactly one shed and the fallback every time", async () => {
    for (let i = 0; i < FLOOD; i += 1) {
      expect(inviteDestination(BROKEN_INVITE)).toBe(FALLBACK_INVITE);
    }
    const { sheds, fires } = captured(warnSpy(), errorSpy());
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires.length).toBeLessThan(FLOOD);
    expect(sheds).toHaveLength(1);
    for (const fire of fires) expectFireShape(fire, { forbidden: INVITE_FORBIDDEN });
    expectShedShape(sheds[0]!, INVITE_FORBIDDEN);
  });

  it("a broken invite config over /discord serves fallback under flood and fires one alert", async () => {
    const env = discordEnv(BROKEN_INVITE);
    for (let i = 0; i < FLOOD; i += 1) {
      const res = await app.request("/discord", {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
    }
    const { alerts, sheds, fires } = captured(warnSpy(), errorSpy());
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires.length).toBeLessThan(FLOOD);
    expect(sheds).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    for (const fire of fires) expectFireShape(fire, { forbidden: INVITE_FORBIDDEN });
    expectShedShape(sheds[0]!, INVITE_FORBIDDEN);
    expectAlertShape(alerts[0]![0], INVITE_FORBIDDEN);
  });

  it("the invite alert re-arms after the window", async () => {
    const env = discordEnv(BROKEN_INVITE);
    const broken = async () => {
      const res = await app.request("/discord", {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
    };
    await broken();
    expect(captured(warnSpy(), errorSpy()).alerts).toHaveLength(1);
    for (let i = 0; i < 10; i += 1) await broken();
    expect(captured(warnSpy(), errorSpy()).alerts).toHaveLength(1);
    now += ALERT_WINDOW_MS + 1;
    await broken();
    const { alerts } = captured(warnSpy(), errorSpy());
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expectAlertShape(alert[0], INVITE_FORBIDDEN);
  });

  it("a usable invite config stays silent", async () => {
    expect(inviteDestination(FALLBACK_INVITE)).toBe(FALLBACK_INVITE);
    const res = await app.request("/discord", {}, discordEnv(FALLBACK_INVITE));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
    expect(captured(warnSpy(), errorSpy()).all).toHaveLength(0);
  });
});
