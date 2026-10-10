// Malformed multipart bodies must answer 4xx (never an alerting 500).
// No database: every assertion below returns before the RSVP store read
// (decoy check -> session check -> status check), so the guard is proven
// without touching the disposable test database.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MALFORMED = {
  "content-type": "multipart/form-data; boundary=x",
};
const alerts = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"error.alert"'));

async function cookieFor(store: SessionStore, userId: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
    avatar: null,
    member: true,
    moderator: false,
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

function envFor(store: SessionStore): Env {
  return {
    APP_URL,
    SESSION_SECRET,
    SESSION_STORE: store,
  } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("rsvp malformed body", () => {
  it("proves the runtime rejects garbage multipart with a TypeError", async () => {
    const err = await new Response("garbage", {
      headers: { "Content-Type": "multipart/form-data; boundary=x" },
    })
      .formData()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(TypeError);
  });

  it("PUT answers 401 (guest) and 422 (member) with no alert", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const env = envFor(store);
    const guest = await app.request(
      `/events/${KEY}/rsvp`,
      {
        method: "PUT",
        headers: { origin: APP_URL, accept: "application/json", ...MALFORMED },
        body: "garbage",
      },
      env,
    );
    expect(guest.status).toBe(401);

    const member = await app.request(
      `/events/${KEY}/rsvp`,
      {
        method: "PUT",
        headers: {
          cookie: await cookieFor(store, "u1"),
          origin: APP_URL,
          accept: "application/json",
          ...MALFORMED,
        },
        body: "garbage",
      },
      env,
    );
    expect(member.status).toBe(422);
    expect(alerts(err)).toHaveLength(0);
  });

  it("POST answers the login redirect (guest) and 422 HTML (member) with no alert", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const env = envFor(store);
    const guest = await app.request(
      `/e/${KEY}/rsvp`,
      {
        method: "POST",
        headers: { origin: APP_URL, ...MALFORMED },
        body: "garbage",
      },
      env,
    );
    // The HTML adapter maps the JSON 401 to its normal login redirect.
    expect(guest.status).toBe(303);
    expect(guest.headers.get("location")).toContain("/join/discord");

    const member = await app.request(
      `/e/${KEY}/rsvp`,
      {
        method: "POST",
        headers: {
          cookie: await cookieFor(store, "u1"),
          origin: APP_URL,
          ...MALFORMED,
        },
        body: "garbage",
      },
      env,
    );
    expect(member.status).toBe(422);
    expect(alerts(err)).toHaveLength(0);
  });

  it("valid JSON and form bodies keep their shape", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const env = envFor(store);
    const guestJson = await app.request(
      `/events/${KEY}/rsvp`,
      {
        method: "PUT",
        headers: {
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "going" }),
      },
      env,
    );
    expect(guestJson.status).toBe(401);

    const memberBadStatus = await app.request(
      `/events/${KEY}/rsvp`,
      {
        method: "PUT",
        headers: {
          cookie: await cookieFor(store, "u1"),
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "status=bogus",
      },
      env,
    );
    expect(memberBadStatus.status).toBe(422);
    expect(alerts(err)).toHaveLength(0);
  });
});
