// route-inventory: POST /logout
// route-inventory: PATCH /events/:key
//
// Malformed-bearer pins for the two session-cookie readers outside the
// acceptance suite's scope: POST /logout (src/auth/routes.ts) and moderator
// event JSON writes (src/events/routes-writes.ts). A correctly-signed but
// malformed bearer must behave as guest with zero session-store calls:
// logout always clears and 303s (even when the store is down), and event
// writes answer the bare unauthenticated refusal, not the expired-session
// recovery bounce. Well-formed unknown bearers keep the authoritative
// behavior as controls.
//
// Hermetic only: memory session store, serializeSigned-minted cookies, no
// DATABASE_URL. The acceptance-owned
// test/session-malformed-cookie-acceptance.test.ts is intentionally untouched;
// its author can port these pins.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { env, EVENT_KEY } from "./helpers/member-data";

// Correctly signed; only the bearer shape is wrong (short body).
const MALFORMED = "two_abc";
// Valid minted shape (`two_` + 43 base64url chars) with no live row.
const WELLFORMED_UNKNOWN = `two_${"A".repeat(43)}`;

const signed = async (value: string) =>
  (
    await serializeSigned(SESSION_COOKIE, value, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const clearedSession = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe("POST /logout with a malformed bearer", () => {
  const logout = (store: SessionStore, cookie: string) =>
    app.request(
      "/logout",
      { method: "POST", headers: { cookie, origin: env.APP_URL } },
      { ...env, SESSION_STORE: store },
    );

  it("clears and 303s with zero store calls", async () => {
    const store = createMemorySessionStore();
    const revoke = vi.spyOn(store, "revoke");
    const revokeLineage = vi.spyOn(store, "revokeLineage");
    const get = vi.spyOn(store, "get");
    const res = await logout(store, await signed(MALFORMED));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(revoke).not.toHaveBeenCalled();
    expect(revokeLineage).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(clearedSession(res).length).toBeGreaterThan(0);
  });

  it("still clears and 303s when the store is down", async () => {
    const store = createMemorySessionStore();
    const revoke = vi.spyOn(store, "revoke").mockRejectedValue(new Error("store down"));
    const res = await logout(store, await signed(MALFORMED));
    expect(res.status).toBe(303);
    expect(revoke).not.toHaveBeenCalled();
    expect(clearedSession(res).length).toBeGreaterThan(0);
  });

  it("control: a well-formed bearer keeps the authoritative 503 when revocation fails", async () => {
    const store = createMemorySessionStore();
    const revoke = vi.spyOn(store, "revoke").mockRejectedValue(new Error("store down"));
    const res = await logout(store, await signed(WELLFORMED_UNKNOWN));
    expect(res.status).toBe(503);
    expect(revoke).toHaveBeenCalledOnce();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("control: a well-formed bearer still revokes on a healthy store", async () => {
    const store = createMemorySessionStore();
    const revoke = vi.spyOn(store, "revoke");
    const res = await logout(store, await signed(WELLFORMED_UNKNOWN));
    expect(res.status).toBe(303);
    expect(revoke).toHaveBeenCalledOnce();
  });
});

describe("moderator event writes with a malformed bearer", () => {
  const patch = (store: SessionStore, cookie: string) =>
    app.request(
      `/events/${EVENT_KEY}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Unsaved edit" }),
      },
      { ...env, SESSION_STORE: store },
    );

  it("answers the bare unauthenticated refusal with zero store reads", async () => {
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const res = await patch(store, await signed(MALFORMED));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(get).not.toHaveBeenCalled();
  });

  it("control: a well-formed unknown bearer keeps the expired-session recovery bounce", async () => {
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const res = await patch(store, await signed(WELLFORMED_UNKNOWN));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      recovery: `/auth/recover?next=${encodeURIComponent(`/e/${EVENT_KEY}`)}`,
    });
    expect(get).toHaveBeenCalled();
  });
});
