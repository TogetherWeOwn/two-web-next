import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import { profilesApp } from "../src/profiles/routes";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { sha256Hex } from "../src/bot/signer";

// No sockets: model only the existing shield SQL and audit writes.
const fixture = vi.hoisted(() => ({ hits: 0, buckets: [] as string[], queries: [] as string[], ends: 0, connects: 0, failAudit: false }));
vi.mock("postgres", () => ({ default: () => {
  fixture.connects++;
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    fixture.queries.push(query);
    if (fixture.failAudit && query.includes("agent_event_audits")) throw new Error("private audit failure");
    if (query.includes("SELECT count(*)")) return [{ n: fixture.hits, wait: 31 }];
    if (query.includes("INSERT INTO agent_event_hits")) {
      fixture.hits++;
      fixture.buckets.push(String(values[0]));
    }
    return [];
  };
  sql.begin = async (fn: (tx: unknown) => unknown) => fn(sql);
  sql.unsafe = async () => [];
  sql.end = async () => { fixture.ends++; };
  return sql;
} }));

const env = { APP_URL: "https://fixture.example.test", SESSION_SECRET: "test-session-secret-at-least-32-bytes-long" } as Env;
const userId = "111111111111111111";
const ERROR = { reason: "payload_too_large", message: "Reduce the size of your request and try again." };

function upload(path: string, method: string, max: number, cookie = "", advertised = false) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array(1024)));
  const request = new Request(new URL(path, env.APP_URL), {
    method, body: new ReadableStream({ pull }, { highWaterMark: 0 }), duplex: "half",
    headers: { origin: env.APP_URL, accept: "application/json", "content-type": "application/json", cookie,
      ...(advertised ? { "content-length": String(max + 1) } : {}) },
  } as RequestInit);
  return { request, pull };
}

async function session(moderator = false) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({ tokenHash: await hashToken(token), userId, username: "member", avatar: null,
    member: true, moderator, expiresAt: new Date(Date.now() + 3600_000) });
  const cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true })).split(";")[0]!;
  return { sessions, cookie };
}

beforeEach(() => { fixture.hits = 0; fixture.buckets = []; fixture.queries = []; fixture.ends = 0; fixture.connects = 0; fixture.failAudit = false; });

describe("profile write admission", () => {
  it.each(["PATCH", "POST"])("%s refuses spent buckets without reading advertised or chunked overflow", async (method) => {
    const { sessions, cookie } = await session();
    const throttle = vi.fn(async () => ({ limited: true as const, retryAfter: 31 }));
    const profile = profilesApp({ sessionStore: sessions, throttle });
    for (const advertised of [false, true]) {
      const { request, pull } = upload(`/members/${userId}`, method, BODY_LIMIT_BYTES.form, cookie, advertised);
      if (method === "POST") request.headers.set("content-type", "application/x-www-form-urlencoded");
      const response = await profile.request(request, undefined, env);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 31 });
      expect(pull).not.toHaveBeenCalled();
      await request.body?.cancel();
    }
    expect(throttle).toHaveBeenCalledTimes(2);
    expect(throttle).toHaveBeenCalledWith(`profile-write:${userId}`);
  });

  it.each(["PATCH", "POST"])("%s spends exactly one attempt on an admitted overflow or valid write", async (method) => {
    const { sessions, cookie } = await session();
    const throttle = vi.fn(async () => ({ limited: false as const }));
    const store = { find: vi.fn(async () => ({ id: userId, username: "member", avatar: null, bio: null, games: [], timezone: null })), save: vi.fn(async () => {}) };
    const profile = profilesApp({ sessionStore: sessions, throttle, store });
    for (const advertised of [false, true]) {
      const { request } = upload(`/members/${userId}`, method, BODY_LIMIT_BYTES.form, cookie, advertised);
      expect((await profile.request(request, undefined, env)).status).toBe(413);
    }
    expect(throttle).toHaveBeenCalledTimes(2);
    expect(store.find).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    const body = method === "POST" ? "_method=PATCH&bio=hello&games_text=" : '{"bio":"hello","games":[]}';
    const response = await profile.request(`/members/${userId}`, { method, body,
      headers: { cookie, accept: "application/json", "content-type": method === "POST" ? "application/x-www-form-urlencoded" : "application/json" } }, env);
    expect(response.status).toBe(200);
    expect(throttle).toHaveBeenCalledTimes(3);
    expect(store.save).toHaveBeenCalledOnce();
  });
});

const moderatorWrites = [
  ["POST", "/events", BODY_LIMIT_BYTES.json],
  ["PATCH", "/events/test-event", BODY_LIMIT_BYTES.json],
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map((action) => ["POST", `/events/test-event/${action}`, BODY_LIMIT_BYTES.action]),
] as [string, string, number][];

describe("moderator admission", () => {
  it.each(moderatorWrites)("%s %s refuses guests and non-moderators without body reads", async (method, path, max) => {
    const { sessions, cookie } = await session();
    for (const presented of ["", cookie]) {
      for (const advertised of [false, true]) {
        const { request, pull } = upload(path, method, max, presented, advertised);
        const response = await app.request(request, undefined, { ...env, SESSION_STORE: sessions } as Env);
        expect(response.status).toBe(presented ? 403 : 401);
        expect(await response.json()).toEqual({ error: presented ? "forbidden" : "unauthenticated" });
        expect(pull).not.toHaveBeenCalled();
        await request.body?.cancel();
      }
    }
  });

  it.each(moderatorWrites)("%s %s authenticates a moderator once before bounding the upload", async (method, path, max) => {
    const { sessions, cookie } = await session(true);
    const get = vi.spyOn(sessions, "get");
    const { request } = upload(path, method, max, cookie);
    const response = await app.request(request, undefined, { ...env, SESSION_STORE: sessions } as Env);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(ERROR);
    expect(get).toHaveBeenCalledOnce();
  });
});

const ingressEnv = { ...env, AGENT_EVENTS_ENABLED: "true", AGENT_DB: { connectionString: "postgres://fixture.invalid/never-connected" } } as Env;
const execution = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} });

describe("agent ingress admission", () => {
  it.each([
    [false, 404, "ingress_disabled"], [true, 503, "ingress_unavailable"],
  ] as const)("environment gate enabled=%s refuses before any reads or SQL", async (enabled, status, reason) => {
    for (const advertised of [false, true]) {
      const { request, pull } = upload("/api/agent-events", "POST", BODY_LIMIT_BYTES.agent, "", advertised);
      const response = await app.request(request, undefined, { ...env, AGENT_EVENTS_ENABLED: String(enabled) });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ reason });
      expect(pull).not.toHaveBeenCalled();
      expect(fixture.connects).toBe(0);
      await request.body?.cancel();
    }
  });

  it.each([null, "test-only-machine-credential"])("spent bucket %s refuses before reading", async (credential) => {
    fixture.hits = 60;
    for (const advertised of [false, true]) {
      const ctx = execution();
      const { request, pull } = upload("/api/agent-events", "POST", BODY_LIMIT_BYTES.agent, "", advertised);
      if (credential) request.headers.set("authorization", `Bearer ${credential}`);
      request.headers.set("cf-connecting-ip", "192.0.2.1");
      const response = await app.request(request, undefined, ingressEnv, ctx);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 31 });
      expect(pull).not.toHaveBeenCalled();
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      await request.body?.cancel();
    }
    expect(fixture.hits).toBe(60);
    expect(fixture.queries.some((q) => /agent_event_grants|agent_event_audits/.test(q))).toBe(false);
    expect(fixture.ends).toBe(2);
  });

  it.each([null, "test-only-machine-credential"])("%s charges overflow once and preserves credential/IP buckets", async (credential) => {
    const expectedBucket = credential ? `shield:${await sha256Hex(credential)}` : "shield:ip:192.0.2.1";
    for (const advertised of [false, true]) {
      const { request } = upload("/api/agent-events", "POST", BODY_LIMIT_BYTES.agent, "", advertised);
      if (credential) request.headers.set("authorization", `Bearer ${credential}`);
      request.headers.set("cf-connecting-ip", "192.0.2.1");
      const response = await app.request(request, undefined, ingressEnv, execution());
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
    }
    expect(fixture.hits).toBe(2);
    expect(fixture.buckets).toEqual([expectedBucket, expectedBucket]);
    expect(fixture.queries.some((q) => /agent_event_grants|agent_event_audits/.test(q))).toBe(false);
    expect(fixture.ends).toBe(2);
  });

  it("retains the static ingress 500 shape and closes the client on service failure", async () => {
    fixture.failAudit = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = execution();
      const response = await app.request("/api/agent-events", { method: "POST", body: "{}" }, ingressEnv, ctx);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ reason: "internal_error", message: "The agent event ingress failed." });
      expect(fixture.ends).toBe(1);
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain("private audit failure");
    } finally {
      log.mockRestore();
    }
  });

  it("closes an admitted client when the upload source rejects", async () => {
    const ctx = execution();
    const request = new Request(new URL("/api/agent-events", env.APP_URL), {
      method: "POST", duplex: "half", headers: { accept: "application/json" },
      body: new ReadableStream({ pull(controller) { controller.error(new Error("private upload failure")); } }, { highWaterMark: 0 }),
    } as RequestInit);
    const response = await app.request(request, undefined, ingressEnv, ctx);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private upload failure");
    expect(fixture.hits).toBe(1);
    expect(fixture.queries.some((q) => /agent_event_grants|agent_event_audits/.test(q))).toBe(false);
    expect(fixture.ends).toBe(1);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("charges one shield hit at the cap and for normal/malformed requests", async () => {
    for (const body of [" ".repeat(BODY_LIMIT_BYTES.agent - 2) + "{}", "{}", "bad-json"]) {
      const response = await app.request("/api/agent-events", { method: "POST", body }, ingressEnv, execution());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ reason: "validation_failed" });
    }
    expect(fixture.hits).toBe(3);
    expect(fixture.queries.filter((q) => q.includes("agent_event_audits"))).toHaveLength(3);
    expect(fixture.ends).toBe(3);
  });
});
