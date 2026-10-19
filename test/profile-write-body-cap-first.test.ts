// Acceptance: on the member profile writes (PATCH /members/:user and the
// edit form's POST /members/:user), the body-size cap is decided before the
// profile-write throttle and before any session or profile-store read. An
// oversized body is therefore a 413 even when the caller is a guest, presents
// an unknown session, is a non-member, is a member editing someone else's
// profile, or has already spent the throttle budget — and it spends neither
// a throttle attempt nor a session/store read. Bodies at or under the cap
// keep the current behavior untouched (guest 401, non-owner 403, owner save,
// validation 422, spent budget 429). Hermetic: the mounted profiles app with
// an in-memory session store, a throttle spy and store spies; no
// DATABASE_URL, no sockets.
import { describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { profilesApp } from "../src/profiles/routes";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://fixture.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL, SESSION_SECRET } as Env;
const USER_ID = "111111111111111111";
const CAP = BODY_LIMIT_BYTES.form;
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const GUEST_401 = { error: "Unauthorized", recovery: "/auth/recover?next=%2Fprofile" };

// The two profile write shapes and the media type each one carries.
const profileWrites = [
  ["PATCH", "application/json"],
  ["POST", "application/x-www-form-urlencoded"],
] as [string, string][];

async function signedCookie(token: string) {
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
}

type Presenter = "guest" | "unknown-session" | "owner" | "non-owner" | "moderator" | "non-member";
const presenters: Presenter[] = [
  "guest",
  "unknown-session",
  "owner",
  "non-owner",
  "moderator",
  "non-member",
];

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
    userId: kind === "owner" ? USER_ID : "222222222222222222",
    username: "member",
    avatar: null,
    member: kind !== "non-member",
    moderator: kind === "moderator",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { sessions, cookie: await signedCookie(token) };
}

function fixture(sessions: ReturnType<typeof createMemorySessionStore>, limited: boolean) {
  const throttle = vi.fn(async (_bucket: string) =>
    limited ? ({ limited: true, retryAfter: 31 } as const) : ({ limited: false } as const),
  );
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
  const profile = profilesApp({ sessionStore: sessions, throttle, store });
  return { profile, throttle, store };
}

function upload(method: string, contentType: string, cookie: string, advertised: boolean) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL(`/members/${USER_ID}`, APP_URL), {
    method,
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: APP_URL,
      accept: "application/json",
      "content-type": contentType,
      cookie,
      ...(advertised ? { "content-length": String(CAP + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

const smallBody = (method: string) =>
  method === "POST" ? "_method=PATCH&bio=hello&games_text=" : '{"bio":"hello","games":[]}';

async function smallRequest(
  kind: Presenter,
  method: string,
  contentType: string,
  limited = false,
  body?: string,
) {
  const { sessions, cookie } = await presenter(kind);
  const get = vi.spyOn(sessions, "get");
  const { profile, throttle, store } = fixture(sessions, limited);
  const response = await profile.request(
    `/members/${USER_ID}`,
    {
      method,
      body: body ?? smallBody(method),
      headers: { cookie, origin: APP_URL, accept: "application/json", "content-type": contentType },
    },
    env,
  );
  return { response, get, throttle, store };
}

const writePresenters = profileWrites.flatMap(([method, contentType]) =>
  presenters.map((kind) => [method, kind, contentType] as [string, Presenter, string]),
);

describe("body-size cap precedes throttle, session and store on profile writes", () => {
  it.each(writePresenters)(
    "%s advertised oversized is 413 for %s, with zero throttle spend and zero session/store reads",
    async (method, kind, contentType) => {
      const { sessions, cookie } = await presenter(kind);
      const get = vi.spyOn(sessions, "get");
      const { profile, throttle, store } = fixture(sessions, false);
      const { request, pull } = upload(method, contentType, cookie, true);
      const response = await profile.request(request, undefined, env);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      expect(throttle).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(store.find).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each(writePresenters)(
    "%s streamed oversized is 413 for %s, with zero throttle spend and zero session/store reads",
    async (method, kind, contentType) => {
      const { sessions, cookie } = await presenter(kind);
      const get = vi.spyOn(sessions, "get");
      const { profile, throttle, store } = fixture(sessions, false);
      const { request, pull } = upload(method, contentType, cookie, false);
      const response = await profile.request(request, undefined, env);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      expect(throttle).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(store.find).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      // Detecting a streamed overflow requires reading, but never more
      // than the cap plus the chunk that crosses it.
      expect(pull.mock.calls.length).toBeLessThanOrEqual(CAP / 1024 + 2);
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each(profileWrites)(
    "%s oversized beats a spent throttle budget (413, not 429) and spends nothing",
    async (method, contentType) => {
      for (const advertised of [true, false]) {
        const { sessions, cookie } = await presenter("owner");
        const get = vi.spyOn(sessions, "get");
        const { profile, throttle, store } = fixture(sessions, true);
        const { request } = upload(method, contentType, cookie, advertised);
        const response = await profile.request(request, undefined, env);
        expect(response.status, `advertised=${advertised}`).toBe(413);
        expect(await response.json(), `advertised=${advertised}`).toEqual(ERROR);
        expect(throttle, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(get, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(store.find, `advertised=${advertised}`).not.toHaveBeenCalled();
        expect(store.save, `advertised=${advertised}`).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    },
  );
});

describe("controls: at/under-cap profile writes keep the current behavior", () => {
  it.each(profileWrites)(
    "%s under-cap guest is the recovery 401, spending nothing",
    async (method, contentType) => {
      const { response, get, throttle, store } = await smallRequest("guest", method, contentType);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(GUEST_401);
      expect(throttle).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(store.find).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it.each(profileWrites)(
    "%s under-cap unknown session is the same 401 after one session read and no throttle spend",
    async (method, contentType) => {
      const { response, get, throttle, store } = await smallRequest(
        "unknown-session",
        method,
        contentType,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(GUEST_401);
      expect(throttle).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledOnce();
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it.each(profileWrites)(
    "%s under-cap owner saves once, after exactly one throttle attempt on the profile-write bucket",
    async (method, contentType) => {
      const { response, get, throttle, store } = await smallRequest("owner", method, contentType);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ saved: true, message: "Profile saved." });
      expect(throttle).toHaveBeenCalledOnce();
      expect(throttle).toHaveBeenCalledWith(`profile-write:${USER_ID}`);
      expect(get).toHaveBeenCalledOnce();
      expect(store.find).toHaveBeenCalledOnce();
      expect(store.save).toHaveBeenCalledOnce();
    },
  );

  it.each(profileWrites)(
    "%s under-cap non-owner member is 403 and saves nothing",
    async (method, contentType) => {
      const { response, get, throttle, store } = await smallRequest(
        "non-owner",
        method,
        contentType,
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
      expect(throttle).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledOnce();
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it.each(profileWrites)(
    "%s under-cap owner validation failure is 422 and saves nothing",
    async (method, contentType) => {
      const body =
        method === "POST"
          ? `_method=PATCH&bio=${"x".repeat(1001)}&games_text=`
          : JSON.stringify({ bio: "x".repeat(1001), games: [] });
      const { response, throttle, store } = await smallRequest(
        "owner",
        method,
        contentType,
        false,
        body,
      );
      expect(response.status).toBe(422);
      if (method === "PATCH")
        expect(await response.json()).toEqual({
          errors: { bio: "Keep your bio to 1000 characters or fewer." },
        });
      expect(throttle).toHaveBeenCalledOnce();
      expect(store.save).not.toHaveBeenCalled();
    },
  );

  it.each(profileWrites)(
    "%s a body of exactly the cap is not a 413: the guest still gets 401",
    async (method, contentType) => {
      const { response, throttle } = await smallRequest(
        "guest",
        method,
        contentType,
        false,
        "x".repeat(CAP),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(GUEST_401);
      expect(throttle).not.toHaveBeenCalled();
    },
  );

  it.each(profileWrites)(
    "%s under-cap owner with a spent budget is still the one 429 shape, saving nothing",
    async (method, contentType) => {
      const { response, throttle, store } = await smallRequest("owner", method, contentType, true);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("31");
      expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 31 });
      expect(throttle).toHaveBeenCalledOnce();
      expect(store.save).not.toHaveBeenCalled();
    },
  );
});
