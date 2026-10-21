// Acceptance: on the moderator event writes, the body-size cap is decided
// before the shared write throttle and before any session read. An oversized
// body is therefore a 413 even when the caller is unauthenticated, presents
// an unknown session, is a plain member, or has already spent the throttle
// budget — and it spends neither a throttle row nor a session read. Bodies
// at or under the cap keep the current order untouched: throttle first
// (429 when spent), then session (401 guest / unknown session, 403 member).
// Hermetic: in-memory session store and a counting throttle Sql double; no
// DATABASE_URL, no sockets.
import { describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { createMemorySessionStore, hashToken, newSessionToken, type Sql } from "../src/sessions";

const APP_URL = "https://fixture.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const USER_ID = "111111111111111111";
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};

// The moderator event writes and the body class each one is capped under
// (same enumeration as test/body-limit-route-admission.test.ts).
const eventWrites = [
  ["POST", "/events", BODY_LIMIT_BYTES.json],
  ["PATCH", "/events/test-event", BODY_LIMIT_BYTES.json],
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map((action) => [
    "POST",
    `/events/test-event/${action}`,
    BODY_LIMIT_BYTES.action,
  ]),
] as [string, string, number][];

function throttleFixture(initial: number) {
  let hits = initial;
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const store = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
  return { sql, store, count: () => hits };
}

async function signedCookie(token: string) {
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
}

type Presenter = "guest" | "unknown-session" | "member" | "moderator";
const presenters: Presenter[] = ["guest", "unknown-session", "member", "moderator"];

// A fresh session store per request so the `get` spy counts exactly the
// reads that one request spends. "unknown-session" presents a well-signed
// cookie whose token was never stored: unauthenticated, but only a session
// read can discover that.
async function presenter(kind: Presenter) {
  const sessions = createMemorySessionStore();
  if (kind === "guest") return { sessions, cookie: "" };
  if (kind === "unknown-session")
    return { sessions, cookie: await signedCookie(newSessionToken()) };
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: USER_ID,
    username: "member",
    avatar: null,
    member: true,
    moderator: kind === "moderator",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { sessions, cookie: await signedCookie(token) };
}

function envFor(
  sessions: ReturnType<typeof createMemorySessionStore>,
  throttle: ReturnType<typeof throttleFixture>,
) {
  return {
    APP_URL,
    SESSION_SECRET,
    SESSION_STORE: sessions,
    THROTTLE_STORE: throttle.store,
  } as unknown as EnvWithThrottle;
}

function upload(path: string, method: string, max: number, cookie: string, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL(path, APP_URL), {
    method,
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: APP_URL,
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      ...(advertised ? { "content-length": String(max + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

function smallRequest(path: string, method: string, cookie: string, body = "{}") {
  return new Request(new URL(path, APP_URL), {
    method,
    body,
    headers: {
      origin: APP_URL,
      accept: "application/json",
      "content-type": "application/json",
      cookie,
    },
  });
}

describe("body-size cap precedes throttle and session on event writes", () => {
  it.each(eventWrites)(
    "%s %s advertised oversized is 413 for every presenter, with zero throttle and zero session reads",
    async (method, path, max) => {
      for (const kind of presenters) {
        const { sessions, cookie } = await presenter(kind);
        const get = vi.spyOn(sessions, "get");
        const throttle = throttleFixture(0);
        const { request, pull } = upload(path, method, max, cookie, true);
        const response = await app.request(request, undefined, envFor(sessions, throttle));
        expect(response.status, kind).toBe(413);
        expect(await response.json(), kind).toMatchObject(ERROR);
        expect(throttle.store, kind).not.toHaveBeenCalled();
        expect(throttle.sql, kind).not.toHaveBeenCalled();
        expect(throttle.count(), kind).toBe(0);
        expect(get, kind).not.toHaveBeenCalled();
        expect(pull, kind).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    },
  );

  it.each(eventWrites)(
    "%s %s streamed oversized is 413 for every presenter, with zero throttle and zero session reads",
    async (method, path, max) => {
      for (const kind of presenters) {
        const { sessions, cookie } = await presenter(kind);
        const get = vi.spyOn(sessions, "get");
        const throttle = throttleFixture(0);
        const { request, pull } = upload(path, method, max, cookie, false);
        const response = await app.request(request, undefined, envFor(sessions, throttle));
        expect(response.status, kind).toBe(413);
        expect(await response.json(), kind).toMatchObject(ERROR);
        expect(throttle.store, kind).not.toHaveBeenCalled();
        expect(throttle.sql, kind).not.toHaveBeenCalled();
        expect(throttle.count(), kind).toBe(0);
        expect(get, kind).not.toHaveBeenCalled();
        // Detecting a streamed overflow requires reading, but never more
        // than the cap plus the chunk that crosses it.
        expect(pull.mock.calls.length, kind).toBeLessThanOrEqual(max / 1024 + 2);
        await request.body?.cancel().catch(() => {});
      }
    },
  );

  it.each(eventWrites)(
    "%s %s oversized beats a spent throttle budget (413, not 429) and spends nothing",
    async (method, path, max) => {
      for (const advertised of [true, false]) {
        const { sessions, cookie } = await presenter("moderator");
        const get = vi.spyOn(sessions, "get");
        const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
        const { request } = upload(path, method, max, cookie, advertised);
        const response = await app.request(request, undefined, envFor(sessions, throttle));
        expect(response.status, `advertised=${advertised}`).toBe(413);
        expect(await response.json(), `advertised=${advertised}`).toMatchObject(ERROR);
        expect(throttle.store, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(throttle.count(), `advertised=${advertised}`).toBe(WRITE_THROTTLE_PER_MINUTE);
        expect(get, `advertised=${advertised}`).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    },
  );
});

describe("controls: at/under-cap event writes keep the current order", () => {
  it.each(eventWrites)(
    "%s %s under-cap guest is 401 after exactly one throttle hit and no session read",
    async (method, path) => {
      const { sessions, cookie } = await presenter("guest");
      const get = vi.spyOn(sessions, "get");
      const throttle = throttleFixture(0);
      const response = await app.request(
        smallRequest(path, method, cookie),
        undefined,
        envFor(sessions, throttle),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
      expect(throttle.count()).toBe(1);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each(eventWrites)(
    "%s %s under-cap unknown session is 401 after one throttle hit and one session read",
    async (method, path) => {
      const { sessions, cookie } = await presenter("unknown-session");
      const get = vi.spyOn(sessions, "get");
      const throttle = throttleFixture(0);
      const response = await app.request(
        smallRequest(path, method, cookie),
        undefined,
        envFor(sessions, throttle),
      );
      expect(response.status).toBe(401);
      // A presented-but-unknown session takes the recovery-shaped 401,
      // unlike the bare-guest { error: "unauthenticated" } above.
      expect(await response.json()).toMatchObject({ error: "Unauthorized" });
      expect(throttle.count()).toBe(1);
      expect(get).toHaveBeenCalledOnce();
    },
  );

  it.each(eventWrites)(
    "%s %s under-cap member is 403 after one throttle hit and one session read",
    async (method, path) => {
      const { sessions, cookie } = await presenter("member");
      const get = vi.spyOn(sessions, "get");
      const throttle = throttleFixture(0);
      const response = await app.request(
        smallRequest(path, method, cookie),
        undefined,
        envFor(sessions, throttle),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(throttle.count()).toBe(1);
      expect(get).toHaveBeenCalledOnce();
    },
  );

  it.each(eventWrites)(
    "%s %s a body of exactly the cap is not a 413: the guest still gets 401",
    async (method, path, max) => {
      const { sessions, cookie } = await presenter("guest");
      const throttle = throttleFixture(0);
      const response = await app.request(
        smallRequest(path, method, cookie, "x".repeat(max)),
        undefined,
        envFor(sessions, throttle),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
      expect(throttle.count()).toBe(1);
    },
  );

  it.each(eventWrites)(
    "%s %s under-cap with a spent budget is still the one 429 shape, with no new hit",
    async (method, path) => {
      const { sessions, cookie } = await presenter("moderator");
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const response = await app.request(
        smallRequest(path, method, cookie),
        undefined,
        envFor(sessions, throttle),
      );
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
      expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    },
  );
});
