// route-inventory: ALL /admin/queue/*
// route-inventory: GET /admin/queue/failed/:id/preview
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import * as previews from "../src/jobs/preview";
import { QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const mocks = vi.hoisted(() => ({ audit: vi.fn(), end: vi.fn(), factory: vi.fn() }));
vi.mock("postgres", () => ({ default: mocks.factory }));
const operator = "100000000000000111";
const secret = "test-session-secret-at-least-32-bytes-long";
const env: Env = {
  APP_URL: STAGING_APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "1545644954272137297",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: secret,
  DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
  QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
  QUEUE_RECONCILE_OPERATOR_ID: operator,
};
const sample: previews.FailedJobPreview = {
  failure: { id: 7, kind: "sync-event", failedAt: "2026-10-07T00:00:00.000Z" },
  observedAt: "2026-10-07T01:00:00.000Z",
  disposition: { action: "discard-stale", reason: "source is clean; dead row is obsolete" },
};

async function cookie(store: SessionStore, userId = operator, moderator = true, expired = false) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: "fixture",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + (expired ? -60000 : 3600000)),
  });
  return (
    await serializeSigned("__Host-two_session", token, secret, {
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    })
  ).split(";")[0]!;
}
function request(
  store: SessionStore,
  init: RequestInit = {},
  bindings = env,
  path = "/admin/queue/failed/7/preview",
  origin = STAGING_APP_URL,
) {
  const app = new Hono().route("/admin", adminApp(store));
  return app.request(
    `${origin}${path}`,
    { ...init, headers: { origin: bindings.APP_URL, ...init.headers } },
    bindings,
  );
}

describe("staging one-row operational preview admission", () => {
  beforeEach(() => {
    mocks.audit.mockResolvedValue([]);
    mocks.end.mockResolvedValue(undefined);
    mocks.factory.mockImplementation(() =>
      Object.assign(mocks.audit, { json: (x: unknown) => x, end: mocks.end }),
    );
    vi.spyOn(previews, "previewFailedJob").mockResolvedValue(sample);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it.each([undefined, "false", "1", "TRUE", "true "])(
    "flag %s is off before any session/source/audit read",
    async (flag) => {
      const store = createMemorySessionStore();
      const bearer = await cookie(store);
      const get = vi.spyOn(store, "get");
      const res = await request(
        store,
        { headers: { cookie: bearer } },
        { ...env, QUEUE_RECONCILE_PREVIEW_ENABLED: flag },
      );
      expect(res.status).toBe(404);
      expect(get).not.toHaveBeenCalled();
      expect(previews.previewFailedJob).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://togetherweown.com",
    "https://next.togetherweown.com/",
    "http://localhost:8787",
    "not a URL",
  ])("nonexact staging configuration %s refuses", async (APP_URL) => {
    const res = await request(createMemorySessionStore(), {}, { ...env, APP_URL });
    expect(res.status).toBe(404);
    expect(previews.previewFailedJob).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "",
    "invalid",
    "100000000000000111,100000000000000222",
    QA_IDENTITIES["qa-member"]!.discordId,
    QA_IDENTITIES["qa-moderator"]!.discordId,
  ])("operator config %s cannot activate a boundary", async (id) => {
    const res = await request(
      createMemorySessionStore(),
      {},
      { ...env, QUEUE_RECONCILE_OPERATOR_ID: id },
    );
    expect(res.status).toBe(404);
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it("a staging APP_URL alone does not admit a foreign request origin", async () => {
    const res = await request(
      createMemorySessionStore(),
      {},
      env,
      undefined,
      "https://elsewhere.example",
    );
    expect(res.status).toBe(404);
  });
  it.each(["", "null", "https://elsewhere.example"])(
    "Origin %s refuses before source reads",
    async (origin) => {
      const res = await request(createMemorySessionStore(), { headers: { origin } });
      expect(res.status).toBe(403);
      expect(previews.previewFailedJob).not.toHaveBeenCalled();
    },
  );
  it("an absent Origin cannot borrow Fetch Metadata or a QA token", async () => {
    const app = new Hono().route("/admin", adminApp(createMemorySessionStore()));
    const res = await app.request(
      `${STAGING_APP_URL}/admin/queue/failed/7/preview`,
      { headers: { "sec-fetch-site": "same-origin", "X-TWO-QA-Auth": "fixture" } },
      env,
    );
    expect(res.status).toBe(403);
  });
  it.each(["HEAD", "POST", "PUT", "PATCH", "DELETE"])(
    "%s has no preview or mutation authority",
    async (method) => {
      const res = await request(createMemorySessionStore(), { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(previews.previewFailedJob).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
  it("write-verb refusal never parses even an oversized supplied payload", async () => {
    const parsers = ["json", "text", "formData", "arrayBuffer"] as const;
    const reads = parsers.map((method) => vi.spyOn(Request.prototype, method));
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const res = await request(store, {
      method: "POST",
      body: "x".repeat(1024 * 1024),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(405);
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(previews.previewFailedJob).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("guest and expired sessions bounce through existing OAuth, never receive advice", async () => {
    const store = createMemorySessionStore();
    for (const bearer of ["", await cookie(store, operator, true, true)]) {
      const res = await request(store, { headers: { cookie: bearer } });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
    }
    expect(previews.previewFailedJob).not.toHaveBeenCalled();
  });
  it.each([
    [operator, false],
    ["100000000000000222", true],
    [QA_IDENTITIES["qa-moderator"]!.discordId, true],
  ] as const)("actor %s moderator=%s lacks dedicated authority", async (id, moderator) => {
    const store = createMemorySessionStore();
    const res = await request(store, { headers: { cookie: await cookie(store, id, moderator) } });
    expect(res.status).toBe(403);
    expect(previews.previewFailedJob).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it("session resolution error refuses without leaking a candidate", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const bearer = await cookie(store);
    vi.spyOn(store, "get").mockRejectedValue(new Error("private session failure"));
    const res = await request(store, { headers: { cookie: bearer } });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("private session failure");
    expect(previews.previewFailedJob).not.toHaveBeenCalled();
  });
  it.each([
    "0",
    "-1",
    "01",
    "1.0",
    "1e2",
    "9007199254740992",
    "7?eventKey=override",
    "7?idempotencyKey=override",
  ])("invalid failure selector %s refuses without a source read", async (id) => {
    const store = createMemorySessionStore();
    const bearer = await cookie(store);
    const path = id.includes("?")
      ? `/admin/queue/failed/${id.split("?")[0]}/preview?${id.split("?")[1]}`
      : `/admin/queue/failed/${id}/preview`;
    const res = await request(store, { headers: { cookie: bearer } }, env, path);
    expect(res.status).toBe(422);
    expect(previews.previewFailedJob).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it("unknown ID is a bounded no-store 404, not a stale candidate", async () => {
    vi.mocked(previews.previewFailedJob).mockResolvedValue(null);
    const store = createMemorySessionStore();
    const res = await request(store, { headers: { cookie: await cookie(store) } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "failure_not_found" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("source error fails closed and does not leak raw diagnostics", async () => {
    vi.mocked(previews.previewFailedJob).mockRejectedValue(new Error("private SQL failure"));
    const store = createMemorySessionStore();
    const res = await request(store, { headers: { cookie: await cookie(store) } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "preview_unavailable" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("success audits exactly once before returning buffered advice, never uses either queue", async () => {
    const store = createMemorySessionStore();
    const bearer = await cookie(store);
    const send = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: bearer } },
      { ...env, SYNC_EVENT_QUEUE: { send } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ previewOnly: true, ...sample });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(previews.previewFailedJob).toHaveBeenCalledExactlyOnceWith(expect.anything(), 7);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["false", "true"])(
    "audit failure always refuses advice with legacy enforce=%s, and closes resources",
    async (enforce) => {
      mocks.audit.mockRejectedValue(new Error("private audit failure"));
      const store = createMemorySessionStore();
      const res = await request(
        store,
        { headers: { cookie: await cookie(store) } },
        { ...env, MEMBER_ACCESS_LOG_ENFORCE: enforce },
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview_unavailable" });
      expect(mocks.end).toHaveBeenCalledTimes(1);
    },
  );
});
