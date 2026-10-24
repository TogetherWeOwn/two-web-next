// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// route-inventory: PATCH /members/:user
// route-inventory: POST /members/:user
// route-inventory: POST /api/agent-events
// Acceptance: every JSON 422 from the event writes (POST/PATCH /events) and
// from profile saves (PATCH plus the form-override POST) carries
// `request_id`, additively, equal to the request's log correlation id — the
// validated id requestLog puts on the http.request line and the
// x-request-id response header, never raw client header bytes. The field
// must hold no secret and no member identity. Without requestLog context
// there is no log correlation id, so the key is omitted rather than
// fabricated (the same rule the shared 429/503 envelopes follow). HTML
// re-renders and the agent ingress envelope are unchanged controls.
import { serializeSigned } from "hono/utils/cookie";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { requestLog } from "../src/request-log";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const RAY = "0123456789abcdef-LHR";
const OTHER_RAY = "fedcba9876543210-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

/** The http.request correlation ids requestLog emitted on console.log. */
function loggedRequestIds(log: { mock: { calls: unknown[][] } }): string[] {
  const ids: string[] = [];
  for (const [line] of log.mock.calls) {
    try {
      const parsed = JSON.parse(String(line)) as { event?: string; request_id?: string };
      if (parsed.event === "http.request" && typeof parsed.request_id === "string")
        ids.push(parsed.request_id);
    } catch {
      // Other console.log output is not a request line.
    }
  }
  return ids;
}

function expectNoLeak(text: string, values: string[]) {
  for (const value of values) if (value) expect(text).not.toContain(value);
}

// ---------------------------------------------------------------------------
// Event writes: POST /events and PATCH /events/:key (real app, disposable DB)
// ---------------------------------------------------------------------------

const EVENT_APP_URL = "https://next.example.test";
const STORED_EVENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MOD_ID = "json-422-moderator";
const SCHEDULE = {
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "Europe/London",
};

describe.skipIf(!process.env.DATABASE_URL)("event JSON 422 request_id (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  const sent: QueueMessage[] = [];
  let env: Env;
  let lastToken = "";

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = {
      APP_URL: EVENT_APP_URL,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET,
      ADMIN_DB: fixture.db,
      SESSION_STORE: store,
      SYNC_EVENT_QUEUE: {
        send: async (message: unknown) => {
          sent.push(message as QueueMessage);
          return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
        },
      },
    } as unknown as Env;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.reset();
    sent.length = 0;
    await fixture.db.insert(events).values({
      eventKey: STORED_EVENT,
      title: "Game night",
      startsAt: new Date("2026-11-04T20:00:00.000Z"),
      endsAt: new Date("2026-11-04T22:00:00.000Z"),
      timezone: "Europe/London",
      status: "draft",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function cookieFor() {
    const token = newSessionToken();
    lastToken = token;
    await store.create({
      tokenHash: await hashToken(token),
      userId: MOD_ID,
      username: "Moderator",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }

  async function write(
    method: "POST" | "PATCH",
    body: string,
    extra: Record<string, string> = { "cf-ray": RAY },
  ) {
    return app.request(
      method === "POST" ? "/events" : `/events/${STORED_EVENT}`,
      {
        method,
        headers: {
          cookie: await cookieFor(),
          origin: EVENT_APP_URL,
          "content-type": "application/json",
          "x-request-id": "client-controlled-id",
          ...extra,
        },
        body,
      },
      env,
    );
  }
  const post = (body: unknown, extra?: Record<string, string>) =>
    write("POST", JSON.stringify(body), extra);
  const patch = (body: unknown, extra?: Record<string, string>) =>
    write("PATCH", JSON.stringify(body), extra);

  const snapshot = async () => ({
    events: await fixture.db.select().from(events),
    audit: await fixture.db.select().from(activityLog),
    rsvps: await fixture.db.select().from(rsvps),
  });

  async function expect422WithRay(res: Response, fields: Record<string, string>) {
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid", fields, request_id: RAY });
    expectNoLeak(text, [
      lastToken,
      SESSION_SECRET,
      MOD_ID,
      "client-controlled-id",
      "client-secret",
    ]);
    expect(sent).toEqual([]);
  }

  it("POST without ends_at carries the logged correlation id", async () => {
    const before = await snapshot();
    const res = await post({
      title: "JSON schedule proof",
      starts_at: SCHEDULE.starts_at,
      timezone: SCHEDULE.timezone,
    });
    await expect422WithRay(res, { ends_at: "When does it end?" });
    const log = vi.mocked(console.log);
    expect(loggedRequestIds(log)).toContain(RAY);
    expect(await snapshot()).toEqual(before);
  });

  it("POST with the end before the start carries the correlation id", async () => {
    const before = await snapshot();
    const res = await post({
      title: "JSON schedule proof",
      starts_at: SCHEDULE.starts_at,
      ends_at: "2026-11-04 19:00",
      timezone: SCHEDULE.timezone,
    });
    await expect422WithRay(res, { ends_at: "The end is after the start." });
    expect(await snapshot()).toEqual(before);
  });

  it("POST with a non-object JSON body carries the correlation id", async () => {
    const before = await snapshot();
    const res = await write("POST", "[]");
    await expect422WithRay(res, { body: "Send a JSON object." });
    expect(await snapshot()).toEqual(before);
  });

  it("PATCH with the end before the start carries the correlation id", async () => {
    const before = await snapshot();
    const res = await patch({
      starts_at: SCHEDULE.starts_at,
      ends_at: "2026-11-04 19:00",
    });
    await expect422WithRay(res, { ends_at: "The end is after the start." });
    expect(await snapshot()).toEqual(before);
  });

  it("PATCH moving only the end before the stored start carries the correlation id", async () => {
    const before = await snapshot();
    const res = await patch({ ends_at: "2026-11-04 19:00" });
    await expect422WithRay(res, { ends_at: "The end is after the start." });
    expect(await snapshot()).toEqual(before);
  });

  it("PATCH with malformed JSON carries the correlation id", async () => {
    const before = await snapshot();
    const res = await write("PATCH", '{"title":');
    await expect422WithRay(res, { body: "Send a JSON object." });
    expect(await snapshot()).toEqual(before);
  });

  it("PATCH with an unknown timezone carries the correlation id", async () => {
    const before = await snapshot();
    const res = await patch({ timezone: "Not/AZone" });
    await expect422WithRay(res, { timezone: "Unknown timezone: Not/AZone." });
    expect(await snapshot()).toEqual(before);
  });

  it("uses the generated id when no Ray id is sent", async () => {
    const res = await post(
      { title: "JSON schedule proof", starts_at: SCHEDULE.starts_at, timezone: SCHEDULE.timezone },
      {},
    );
    expect(res.status).toBe(422);
    const generated = res.headers.get("x-request-id");
    expect(generated).toMatch(ULID);
    const body = (await res.json()) as { request_id?: string };
    expect(body.request_id).toBe(generated);
    expect(loggedRequestIds(vi.mocked(console.log))).toContain(generated);
  });

  it.each(["cookie-secret", "100000000000000001", SESSION_SECRET, `${RAY}"><b>x</b>`])(
    "replaces hostile cf-ray %s with the generated correlation id",
    async (ray) => {
      const res = await post(
        {
          title: "JSON schedule proof",
          starts_at: SCHEDULE.starts_at,
          timezone: SCHEDULE.timezone,
        },
        { "cf-ray": ray },
      );
      expect(res.status).toBe(422);
      const generated = res.headers.get("x-request-id");
      expect(generated).not.toBe(ray);
      expect(generated).toMatch(ULID);
      const text = await res.text();
      expect((JSON.parse(text) as { request_id?: string }).request_id).toBe(generated);
      expectNoLeak(text, [ray, lastToken, MOD_ID]);
    },
  );

  it("gives each request its own correlation id", async () => {
    const invalid = {
      title: "JSON schedule proof",
      starts_at: SCHEDULE.starts_at,
      timezone: SCHEDULE.timezone,
    };
    const first = await post(invalid, { "cf-ray": RAY });
    const second = await post(invalid, { "cf-ray": OTHER_RAY });
    expect(((await first.json()) as { request_id?: string }).request_id).toBe(RAY);
    expect(((await second.json()) as { request_id?: string }).request_id).toBe(OTHER_RAY);
  });
});

// ---------------------------------------------------------------------------
// Profile saves: PATCH and form-override POST on /members/:user (hermetic)
// ---------------------------------------------------------------------------

const PROFILE_ID = "100000000000000001";
const PROFILE_URL = "https://next.example.test";
const TIMEZONE_ERROR = "Choose a valid IANA timezone, e.g. Europe/London.";

async function profileSetup(logged: boolean) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: PROFILE_ID,
    username: "alice",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const store = createMemoryProfileStore([
    {
      id: PROFILE_ID,
      username: "alice",
      avatar: null,
      bio: "Hi",
      games: ["Chess"],
      timezone: "UTC",
    },
  ]);
  const save = vi.spyOn(store, "save");
  const inner = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  // The production mount runs requestLog ahead of the profile routes; the
  // bare profilesApp is the no-log-context control.
  let client: { request: typeof inner.request } = inner;
  if (logged) {
    const router = new Hono<{ Bindings: Env }>();
    router.use("*", requestLog);
    router.route("/", inner);
    client = router;
  }
  const env = { APP_URL: PROFILE_URL, SESSION_SECRET } as Env;
  const send = (
    body: BodyInit,
    type: string,
    accept: string,
    method = "PATCH",
    extra: Record<string, string> = { "cf-ray": RAY },
  ) =>
    client.request(
      `/members/${PROFILE_ID}`,
      {
        method,
        headers: {
          cookie,
          origin: PROFILE_URL,
          "content-type": type,
          accept,
          "x-request-id": "client-controlled-id",
          ...extra,
        },
        body,
      },
      env,
    );
  const json = (obj: unknown, accept = "application/json", extra?: Record<string, string>) =>
    send(JSON.stringify(obj), "application/json", accept, "PATCH", extra);
  return { store, save, send, json, token };
}

const invalidProfile = { bio: "a", timezone: "Mars/Base", games: ["<b>x</b>"] };

describe("profile JSON 422 request_id", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("PATCH with an invalid timezone carries the logged correlation id", async () => {
    const { store, save, json, token } = await profileSetup(true);
    const res = await json(invalidProfile);
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      errors: { timezone: TIMEZONE_ERROR },
      request_id: RAY,
    });
    expect(loggedRequestIds(vi.mocked(console.log))).toContain(RAY);
    expectNoLeak(text, [token, SESSION_SECRET, PROFILE_ID, "alice", "client-controlled-id"]);
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(PROFILE_ID)).toMatchObject({ bio: "Hi", games: ["Chess"] });
  });

  it("form-override POST with an invalid timezone carries the correlation id", async () => {
    const { save, send, token } = await profileSetup(true);
    const res = await send(
      "_method=PATCH&bio=a&timezone=Mars%2FBase&games_text=Go",
      "application/x-www-form-urlencoded",
      "application/json",
      "POST",
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      errors: { timezone: TIMEZONE_ERROR },
      request_id: RAY,
    });
    expectNoLeak(text, [token, SESSION_SECRET, PROFILE_ID, "alice"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("form-encoded PATCH with an invalid timezone carries the correlation id", async () => {
    const { save, send } = await profileSetup(true);
    const res = await send(
      new URLSearchParams({ bio: "a", timezone: "Mars/Base", games_text: "Go" }).toString(),
      "application/x-www-form-urlencoded",
      "application/json",
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      errors: { timezone: TIMEZONE_ERROR },
      request_id: RAY,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("PATCH omitting both games representations carries the correlation id additively", async () => {
    const { save, json } = await profileSetup(true);
    const res = await json({ bio: "Updated", timezone: "UTC" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      errors: Record<string, string>;
      request_id?: string;
    };
    expect(Object.keys(body).sort()).toEqual(["errors", "request_id"]);
    expect(body.errors.games).toBeTruthy();
    expect(body.request_id).toBe(RAY);
    expect(save).not.toHaveBeenCalled();
  });

  it("uses the generated id when no Ray id is sent", async () => {
    const { json } = await profileSetup(true);
    const res = await json(invalidProfile, "application/json", {});
    expect(res.status).toBe(422);
    const generated = res.headers.get("x-request-id");
    expect(generated).toMatch(ULID);
    expect(((await res.json()) as { request_id?: string }).request_id).toBe(generated);
    expect(loggedRequestIds(vi.mocked(console.log))).toContain(generated);
  });

  it.each(["cookie-secret", PROFILE_ID, SESSION_SECRET, `${RAY}"><b>x</b>`])(
    "replaces hostile cf-ray %s with the generated correlation id",
    async (ray) => {
      const { json, token } = await profileSetup(true);
      const res = await json(invalidProfile, "application/json", { "cf-ray": ray });
      expect(res.status).toBe(422);
      const generated = res.headers.get("x-request-id");
      expect(generated).not.toBe(ray);
      expect(generated).toMatch(ULID);
      const text = await res.text();
      expect((JSON.parse(text) as { request_id?: string }).request_id).toBe(generated);
      expectNoLeak(text, [ray, token, "alice"]);
    },
  );

  it("omits request_id without requestLog context, even when a raw cf-ray is sent", async () => {
    const { json } = await profileSetup(false);
    const res = await json(invalidProfile);
    expect(res.status).toBe(422);
    expect(res.headers.get("x-request-id")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ errors: { timezone: TIMEZONE_ERROR } });
    expect("request_id" in body).toBe(false);
  });

  it("keeps the JSON success acknowledgement exactly as it was (control)", async () => {
    const { store, save, json } = await profileSetup(true);
    const res = await json({ bio: "Updated", timezone: "UTC", games: ["Go", "Chess"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.rows.get(PROFILE_ID)?.games).toEqual(["Go", "Chess"]);
  });

  it("keeps the HTML 422 re-render on the escaped form path (control)", async () => {
    const { save, json } = await profileSetup(true);
    const res = await json(invalidProfile, "text/html");
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Agent ingress envelope: unchanged control (it already correlates)
// ---------------------------------------------------------------------------

describe("agent ingress envelope shape (control)", () => {
  const CALLER = "agent-422-control";
  const CRED = "cred-422-control-001";
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the agent control paths");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function agentEnv() {
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-422-control",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    return {
      APP_URL: "https://next.example.test",
      AGENT_EVENTS_ENABLED: "true",
      AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
      AGENT_EVENT_SQL: fake.sql,
    } as unknown as Env;
  }

  const call = (env: Env, payload: unknown) =>
    app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
          "cf-ray": RAY,
        },
        body: JSON.stringify(payload),
      },
      env,
      executionCtx,
    );

  it("keeps {reason, message, request_id} on an unknown operation", async () => {
    const res = await call(await agentEnv(), { op: "delete", idempotency_key: "ctrl-001" });
    expect(res.status).toBe(403);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "reason", "request_id"]);
    expect(body.reason).toBe("forbidden_action");
    expect(body.request_id).toMatch(ULID);
    expectNoLeak(text, [CRED, CALLER]);
  });

  it("keeps {reason, message, errors, request_id} on invalid create fields", async () => {
    const res = await call(await agentEnv(), {
      op: "create",
      idempotency_key: "ctrl-002",
      fields: { title: "" },
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "errors",
      "message",
      "next",
      "reason",
      "request_id",
    ]);
    expect(body.reason).toBe("validation_failed");
    expect(body.request_id).toMatch(ULID);
    expectNoLeak(text, [CRED, CALLER]);
  });
});
