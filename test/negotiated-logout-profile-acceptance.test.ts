// Protected acceptance tests: production fixes must not edit this file.
// A refusal must retain its status and side effects, offer browser recovery,
// and never expose submitted content or an internal exception. Hermetic seams
// replace session/profile storage only; the mounted handlers/renderers are real.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { requestLog } from "../src/request-log";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, env, MEMBER } from "./helpers/member-data";

vi.mock("postgres", () => ({
  default: () => {
    throw new Error("acceptance fixtures must not open a database");
  },
}));

const BROWSER = "text/html,application/xhtml+xml";
const RAY = "0000000000000001-LHR";
const PRIVATE = "private profile fixture details";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("fixture must remain offline"))),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function branded(response: Response, status: number, heading: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  const body = await response.text();
  expect(body).toContain(heading);
  expect(body).toContain('id="error-heading"');
  expect(body).toContain('name="robots" content="noindex, nofollow"');
  expect(body).toContain('href="/"');
  expect(body).not.toContain(PRIVATE);
  expect(
    response.headers
      .get("cache-control")
      ?.split(",")
      .map((s) => s.trim())
      .sort(),
  ).toEqual(["no-store", "private"]);
  return body;
}

async function logout(accept: string) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MEMBER);
  const revoke = vi.spyOn(sessions, "revoke").mockRejectedValue(new Error(PRIVATE));
  const response = await app.request(
    "/logout",
    {
      method: "POST",
      headers: { origin: env.APP_URL, cookie, accept, "cf-ray": RAY },
    },
    { ...env, SESSION_STORE: sessions } as Env,
  );
  return { response, revoke };
}

describe("logout revocation failure stays authoritative and offers browser recovery", () => {
  it("returns branded 503 with correlation/retry guidance and no cleared bearer", async () => {
    const { response, revoke } = await logout(BROWSER);
    expect(response.status).toBe(503);
    expect(revoke).toHaveBeenCalledOnce();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("location")).toBeNull();
    const body = await branded(response, 503, "We will be right back");
    expect(body).toContain('data-testid="error-support-reference"');
    expect(body).toContain(RAY);
    expect(body).toMatch(/try again/i);
    expect(body).toContain('href="https://discord.gg/invite"');
    expect(body).not.toContain('href="/auth/discord"');
  });

  it("JSON sign-out failure preserves its existing plaintext bytes and does not clear cookies", async () => {
    const { response, revoke } = await logout("application/json");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Sign-out temporarily unavailable");
    expect(revoke).toHaveBeenCalledOnce();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("location")).toBeNull();
  });
});

type Refusal =
  | "unsupported media"
  | "malformed JSON"
  | "malformed multipart"
  | "JSON null"
  | "JSON array"
  | "save error";
const refusals: { name: Refusal; body: string; type: string; status: number; heading: string }[] = [
  {
    name: "unsupported media",
    body: PRIVATE,
    type: "text/plain",
    status: 415,
    heading: "Check your request",
  },
  {
    name: "malformed JSON",
    body: '{"bio":',
    type: "application/json",
    status: 400,
    heading: "Check your request",
  },
  {
    name: "malformed multipart",
    body: PRIVATE,
    type: "multipart/form-data; boundary=fixture-boundary",
    status: 400,
    heading: "Check your request",
  },
  {
    name: "JSON null",
    body: "null",
    type: "application/json",
    status: 400,
    heading: "Check your request",
  },
  {
    name: "JSON array",
    body: "[]",
    type: "application/json",
    status: 400,
    heading: "Check your request",
  },
  {
    name: "save error",
    body: '{"bio":"updated","games":[]}',
    type: "application/json",
    status: 500,
    heading: "Something broke on our side",
  },
];

async function profileRequest(failure: (typeof refusals)[number], accept: string, form = false) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MEMBER);
  const store = {
    find: vi.fn(async () => ({
      id: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      bio: PRIVATE,
      games: [],
      timezone: null,
    })),
    save: vi.fn(async () => {
      if (failure.name === "save error") throw new Error(PRIVATE);
    }),
  };
  const mounted = new Hono<{ Bindings: Env }>();
  mounted.use("*", requestLog);
  mounted.route(
    "/",
    profilesApp({ sessionStore: sessions, store, throttle: async () => ({ limited: false }) }),
  );
  const response = await mounted.request(
    `/members/${MEMBER.userId}`,
    {
      method: form ? "POST" : "PATCH",
      headers: {
        origin: env.APP_URL,
        accept,
        cookie,
        "cf-ray": RAY,
        "content-type": form ? "application/x-www-form-urlencoded" : failure.type,
      },
      body: form ? "_method=PATCH&bio=updated&games_text=" : failure.body,
    },
    env,
  );
  return { response, store };
}

describe("profile write refusals negotiate without changing statuses or successful writes", () => {
  it.each(refusals)(
    "$name offers a branded $status without echoing private content",
    async (failure) => {
      const { response, store } = await profileRequest(failure, BROWSER);
      expect(response.status).toBe(failure.status);
      expect(store.find).toHaveBeenCalledWith(MEMBER.userId);
      if (failure.name === "save error") expect(store.save).toHaveBeenCalledOnce();
      else expect(store.save).not.toHaveBeenCalled();
      await branded(response, failure.status, failure.heading);
    },
  );

  it("plain form POST save failure also renders branded 500, not a redirect or 400", async () => {
    const failure = refusals.find((row) => row.name === "save error")!;
    const { response, store } = await profileRequest(failure, BROWSER, true);
    expect(response.status).toBe(500);
    expect(store.save).toHaveBeenCalledOnce();
    expect(response.headers.get("location")).toBeNull();
    await branded(response, 500, "Something broke on our side");
  });

  it.each(refusals.filter((row) => row.status === 400))(
    "$name JSON refusal uses the new static bad_request envelope",
    async (failure) => {
      const { response, store } = await profileRequest(failure, "application/json");
      expect(response.status).toBe(400);
      expect(store.save).not.toHaveBeenCalled();
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "bad_request", message: expect.any(String) });
    },
  );

  it.each([
    ["unsupported media", 415, "Unsupported Media Type"],
    ["save error", 500, "Could not save your profile."],
  ] as const)("%s retains the machine caller's existing %i bytes", async (name, status, body) => {
    const failure = refusals.find((row) => row.name === name)!;
    const { response } = await profileRequest(failure, "application/json");
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(body);
  });

  it("valid JSON still saves once and returns the exact success envelope", async () => {
    const failure = {
      ...refusals[0]!,
      name: "malformed JSON" as const,
      type: "application/json",
      body: '{"bio":"updated","games":[]}',
    };
    const { response, store } = await profileRequest(failure, "application/json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, message: "Profile saved." });
    expect(store.save).toHaveBeenCalledOnce();
  });
});
