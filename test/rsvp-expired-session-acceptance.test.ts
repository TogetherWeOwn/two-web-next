// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// route-inventory: POST /e/:key/rsvp
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "local-fixture-secret-at-least-32-bytes-long";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NEXT = `/e/${KEY}?attendees=2`;
const RECOVERY = "/auth/recover?next=" + encodeURIComponent(NEXT);
const JOIN = "/join/discord?next=" + encodeURIComponent(`/e/${KEY}`);

const sign = async (token: string) =>
  (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;

function fixture() {
  const sessions = createMemorySessionStore();
  const effects = { database: 0, queue: 0, network: 0 };
  const env = {
    APP_URL,
    SESSION_SECRET,
    SESSION_STORE: sessions,
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_CLIENT_SECRET: "fixture-secret",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_BOT_TOKEN: "fixture-bot",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    // Any attempt to read or mutate event/throttle rows fails before a driver exists.
    ADMIN_DB: new Proxy(
      {},
      {
        get() {
          effects.database++;
          throw new Error("Unauthenticated RSVP must not reach a database");
        },
      },
    ),
    SYNC_EVENT_QUEUE: {
      send: async () => {
        effects.queue++;
        throw new Error("Unauthenticated RSVP must not enqueue a write");
      },
    },
  } as unknown as Env;
  vi.stubGlobal("fetch", async () => {
    effects.network++;
    throw new Error("Unexpected outbound request in local acceptance fixture");
  });
  async function cookie(kind: string) {
    if (kind === "no-cookie") return undefined;
    if (kind === "unsigned") return "__Host-two_session=not-a-signed-bearer";
    if (kind === "signed-malformed") return sign("too-short");
    const token = newSessionToken();
    if (kind === "expired") {
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: "fixture-member",
        username: "Fixture member",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(0),
      });
    }
    // A well-formed signed token with no row also represents a dead bearer.
    return sign(token);
  }
  return { env, effects, cookie };
}

describe("expired-session RSVP recovery (no database or network)", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(f.effects).toEqual({ database: 0, queue: 0, network: 0 });
  });

  for (const method of ["PUT", "DELETE"]) {
    it.each(["expired", "missing-row"])(
      `${method} with a %s bearer stays a JSON 401 and offers recovery, not a redirect`,
      async (kind) => {
        const res = await app.request(
          `/events/${KEY}/rsvp`,
          {
            method,
            headers: {
              cookie: (await f.cookie(kind))!,
              origin: APP_URL,
              referer: APP_URL + NEXT,
              accept: "application/json",
              "content-type": "application/json",
            },
            ...(method === "PUT" ? { body: JSON.stringify({ status: "going" }) } : {}),
          },
          f.env,
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual({
          error: "unauthenticated",
          recovery: RECOVERY,
          request_id: expect.any(String),
        });
        expect(res.headers.getSetCookie()).toEqual([]);
      },
    );

    it.each(["no-cookie", "unsigned", "signed-malformed"])(
      `${method} with %s keeps the guest refusal without a recovery claim`,
      async (kind) => {
        const cookie = await f.cookie(kind);
        const res = await app.request(
          `/events/${KEY}/rsvp`,
          {
            method,
            headers: {
              ...(cookie ? { cookie } : {}),
              origin: APP_URL,
              accept: "application/json",
              "content-type": "application/json",
            },
            ...(method === "PUT" ? { body: JSON.stringify({ status: "going" }) } : {}),
          },
          f.env,
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("location")).toBeNull();
        expect(await res.json()).toEqual({
          error: "unauthenticated",
          request_id: expect.any(String),
        });
      },
    );
  }

  it.each(["PUT", "DELETE"])(
    "%s with an expired bearer and no JSON negotiation cannot redirect into a false success",
    async (method) => {
      const res = await app.request(
        `/events/${KEY}/rsvp`,
        {
          method,
          headers: {
            cookie: (await f.cookie("expired"))!,
            origin: APP_URL,
            referer: APP_URL + NEXT,
          },
        },
        f.env,
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({
        error: "unauthenticated",
        recovery: RECOVERY,
        request_id: expect.any(String),
      });
    },
  );

  for (const status of ["going", "withdraw"]) {
    it.each(["expired", "missing-row"])(
      `native POST ${status} with a %s bearer follows recovery instead of the guest join funnel`,
      async (kind) => {
        const res = await app.request(
          `/e/${KEY}/rsvp`,
          {
            method: "POST",
            headers: {
              cookie: (await f.cookie(kind))!,
              origin: APP_URL,
              referer: APP_URL + NEXT,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ status }).toString(),
          },
          f.env,
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(RECOVERY);
        const landing = await app.request(RECOVERY, {}, f.env);
        expect(landing.status).toBe(200);
        expect(await landing.text()).toContain("Your earlier changes were not saved");
      },
    );

    it.each(["no-cookie", "unsigned", "signed-malformed"])(
      `native POST ${status} with %s keeps the existing join destination`,
      async (kind) => {
        const cookie = await f.cookie(kind);
        const res = await app.request(
          `/e/${KEY}/rsvp`,
          {
            method: "POST",
            headers: {
              ...(cookie ? { cookie } : {}),
              origin: APP_URL,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ status }).toString(),
          },
          f.env,
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(JOIN);
      },
    );
  }
});
