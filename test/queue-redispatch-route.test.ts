// route-inventory: ALL /admin/queue/*
// route-inventory: ALL /admin/queue/failed/:id/redispatch
// route-inventory: POST /admin/queue/failed/:id/redispatch
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { RedispatchDeps } from "../src/admin/queue-redispatch";
import type { Env } from "../src/env";
import * as previews from "../src/jobs/preview";
import type { FailedJobReplayCandidate } from "../src/jobs/preview";
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
const replayPreview = {
  failure: { id: 7, kind: "sync-event", failedAt: "2026-10-07T00:00:00.000Z" },
  observedAt: "2026-10-07T01:00:00.000Z",
  disposition: { action: "replay", reason: "source is still dirty; fresh dispatch" },
} as const;
const replayCandidate: FailedJobReplayCandidate = {
  preview: { ...replayPreview, disposition: { ...replayPreview.disposition } },
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
};
const keepCandidate: FailedJobReplayCandidate = {
  preview: {
    ...replayPreview,
    disposition: {
      action: "keep",
      reason: "definitive refusal; operator recovery required, preserve dead row and snapshot",
    },
  },
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
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
// The write envelope's throttle consults this instead of a database: the
// route suite proves guard ordering (untouched before the handler is
// reachable), while the shared throttle suite owns the marker and the
// Postgres suite owns the real bucket.
const throttleStore = vi.fn(async () => null);
function request(
  store: SessionStore,
  init: RequestInit = {},
  bindings = env,
  path = "/admin/queue/failed/7/redispatch",
  origin = STAGING_APP_URL,
  deps: RedispatchDeps = {
    loadCandidate: async () => replayCandidate,
    dispatch: async () => true,
  },
) {
  const app = new Hono().route("/admin", adminApp(store));
  return app.request(
    `${origin}${path}`,
    { method: "POST", ...init, headers: { origin: bindings.APP_URL, ...init.headers } },
    { ...bindings, REDISPATCH_DEPS: deps, THROTTLE_STORE: throttleStore } as Env,
  );
}

describe("staging one-row guarded re-dispatch admission", () => {
  beforeEach(() => {
    mocks.audit.mockResolvedValue([]);
    mocks.end.mockResolvedValue(undefined);
    mocks.factory.mockImplementation(() =>
      Object.assign(mocks.audit, { json: (x: unknown) => x, end: mocks.end }),
    );
    // A store failure allows (a missed count beats a 500); the seam only
    // records that the envelope consulted the bucket.
    throttleStore.mockImplementation(async () => null);
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
      const loadCandidate = vi.fn();
      const res = await request(
        store,
        { headers: { cookie: bearer } },
        { ...env, QUEUE_RECONCILE_PREVIEW_ENABLED: flag },
        undefined,
        undefined,
        { loadCandidate },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "redispatch_disabled" });
      expect(get).not.toHaveBeenCalled();
      expect(loadCandidate).not.toHaveBeenCalled();
      expect(throttleStore).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://togetherweown.com",
    "https://next.togetherweown.com/",
    "http://localhost:8787",
    "not a URL",
  ])("nonexact staging configuration %s refuses", async (APP_URL) => {
    const loadCandidate = vi.fn();
    const res = await request(
      createMemorySessionStore(),
      {},
      { ...env, APP_URL },
      undefined,
      undefined,
      { loadCandidate },
    );
    expect(res.status).toBe(404);
    expect(loadCandidate).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "",
    "invalid",
    "100000000000000111,100000000000000222",
    QA_IDENTITIES["qa-member"]!.discordId,
    QA_IDENTITIES["qa-moderator"]!.discordId,
  ])("operator config %s cannot activate a boundary", async (id) => {
    const loadCandidate = vi.fn();
    const res = await request(
      createMemorySessionStore(),
      {},
      { ...env, QUEUE_RECONCILE_OPERATOR_ID: id },
      undefined,
      undefined,
      { loadCandidate },
    );
    expect(res.status).toBe(404);
    expect(loadCandidate).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it("a staging APP_URL alone does not admit a foreign request origin", async () => {
    const loadCandidate = vi.fn();
    const res = await request(
      createMemorySessionStore(),
      {},
      env,
      undefined,
      "https://elsewhere.example",
      { loadCandidate },
    );
    expect(res.status).toBe(404);
    expect(loadCandidate).not.toHaveBeenCalled();
  });
  it.each(["", "null", "https://elsewhere.example"])(
    "Origin %s refuses before source reads",
    async (origin) => {
      const loadCandidate = vi.fn();
      const res = await request(
        createMemorySessionStore(),
        { headers: { origin } },
        env,
        undefined,
        undefined,
        {
          loadCandidate,
        },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_origin" });
      expect(loadCandidate).not.toHaveBeenCalled();
    },
  );
  it("an absent Origin cannot borrow Fetch Metadata or a QA token", async () => {
    const app = new Hono().route("/admin", adminApp(createMemorySessionStore()));
    const res = await app.request(
      `${STAGING_APP_URL}/admin/queue/failed/7/redispatch`,
      {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "X-TWO-QA-Auth": "fixture" },
      },
      { ...env, REDISPATCH_DEPS: { loadCandidate: vi.fn() } } as Env,
    );
    expect(res.status).toBe(403);
  });
  it.each(["GET", "HEAD", "PUT", "PATCH", "DELETE"])(
    "%s has no redispatch authority",
    async (method) => {
      const store = createMemorySessionStore();
      const get = vi.spyOn(store, "get");
      const loadCandidate = vi.fn();
      const res = await request(store, { method }, env, undefined, undefined, { loadCandidate });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(get).not.toHaveBeenCalled();
      expect(loadCandidate).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
  it("a supplied payload is never parsed; dispatch starts from the reconciled source", async () => {
    const parsers = ["json", "text", "formData", "arrayBuffer"] as const;
    const reads = parsers.map((method) => vi.spyOn(Request.prototype, method));
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(
      store,
      {
        body: JSON.stringify({ eventKey: "forged", idempotencyKey: "forged" }),
        headers: { cookie: await cookie(store), "content-type": "application/json" },
      },
      env,
      undefined,
      undefined,
      { loadCandidate: async () => replayCandidate, dispatch },
    );
    expect(res.status).toBe(200);
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(replayCandidate.eventKey, expect.any(String));
  });
  it("an oversized supplied payload is refused by size, still never parsed", async () => {
    const parsers = ["json", "text", "formData", "arrayBuffer"] as const;
    const reads = parsers.map((method) => vi.spyOn(Request.prototype, method));
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(
      store,
      {
        body: "x".repeat(1024 * 1024),
        headers: { cookie: await cookie(store), "content-type": "application/json" },
      },
      env,
      undefined,
      undefined,
      { loadCandidate: async () => replayCandidate, dispatch },
    );
    expect(res.status).toBe(413);
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("guest and expired sessions bounce through existing OAuth, never dispatch", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn();
    for (const bearer of ["", await cookie(store, operator, true, true)]) {
      const res = await request(store, { headers: { cookie: bearer } }, env, undefined, undefined, {
        loadCandidate: async () => replayCandidate,
        dispatch,
      });
      // A bounced write goes back to the page, never into a re-submit.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toMatch(/^\/auth\/recover\?next=/);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("a signed-in non-moderator is forbidden by the panel gate, never dispatched", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store, operator, false) } },
      env,
      undefined,
      undefined,
      { loadCandidate: async () => replayCandidate, dispatch },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it.each(["100000000000000222", QA_IDENTITIES["qa-moderator"]!.discordId])(
    "moderator %s lacks dedicated authority",
    async (id) => {
      const store = createMemorySessionStore();
      const dispatch = vi.fn();
      const res = await request(
        store,
        { headers: { cookie: await cookie(store, id, true) } },
        env,
        undefined,
        undefined,
        { loadCandidate: async () => replayCandidate, dispatch },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "operator_required" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
  it("session resolution error refuses without leaking a candidate", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const bearer = await cookie(store);
    vi.spyOn(store, "get").mockRejectedValue(new Error("private session failure"));
    const dispatch = vi.fn();
    const res = await request(store, { headers: { cookie: bearer } }, env, undefined, undefined, {
      loadCandidate: async () => replayCandidate,
      dispatch,
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("private session failure");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "01", "1.0", "1e2", "9007199254740992"])(
    "invalid failure selector %s refuses without a source read",
    async (id) => {
      const store = createMemorySessionStore();
      const loadCandidate = vi.fn();
      const res = await request(
        store,
        { headers: { cookie: await cookie(store) } },
        env,
        `/admin/queue/failed/${id}/redispatch`,
        undefined,
        { loadCandidate },
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid_failure_id" });
      expect(loadCandidate).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
  it("query overrides refuse without a source read", async () => {
    const store = createMemorySessionStore();
    const loadCandidate = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      "/admin/queue/failed/7/redispatch?reason=override",
      undefined,
      { loadCandidate },
    );
    expect(res.status).toBe(422);
    expect(loadCandidate).not.toHaveBeenCalled();
  });
  it("unknown ID is a bounded no-store 404, never audited", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      {
        loadCandidate: async () => null,
        dispatch,
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "failure_not_found" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("source error fails closed and does not leak raw diagnostics", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      {
        loadCandidate: async () => {
          throw new Error("private SQL failure");
        },
        dispatch,
      },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("a keep advice refuses without dispatching, deleting or auditing", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn();
    const send = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      { ...env, SYNC_EVENT_QUEUE: { send } },
      undefined,
      undefined,
      { loadCandidate: async () => keepCandidate, dispatch },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "redispatch_refused",
      failure: keepCandidate.preview.failure,
      disposition: keepCandidate.preview.disposition,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("a missing queue binding fails closed before anything is written", async () => {
    const store = createMemorySessionStore();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      { loadCandidate: async () => replayCandidate },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("a dispatch failure fails closed without an audit receipt", async () => {
    const store = createMemorySessionStore();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      {
        loadCandidate: async () => replayCandidate,
        dispatch: async () => {
          throw new Error("private queue failure");
        },
      },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("a held lock reports the in-flight dispatch instead of queueing a duplicate", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => false);
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      {
        loadCandidate: async () => replayCandidate,
        dispatch,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      redispatched: true,
      deduped: true,
      ...replayCandidate.preview,
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(replayCandidate.eventKey, expect.any(String));
    // No second send means no second receipt: the first submit owns the audit.
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("a due recovery reuses its immutable request identity", async () => {
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const candidate: FailedJobReplayCandidate = {
      ...replayCandidate,
      idempotencyKey: "original-request-identity",
    };
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      {
        loadCandidate: async () => candidate,
        dispatch,
      },
    );
    expect(res.status).toBe(200);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      replayCandidate.eventKey,
      "original-request-identity",
    );
  });
  it("success dispatches exactly once, audits once, and never reads the preview entrypoint", async () => {
    const store = createMemorySessionStore();
    const previewSpy = vi.spyOn(previews, "previewFailedJob");
    const dispatch = vi.fn(async () => true);
    const send = vi.fn();
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      { ...env, SYNC_EVENT_QUEUE: { send } },
      undefined,
      undefined,
      { loadCandidate: async () => replayCandidate, dispatch },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redispatched: true, ...replayCandidate.preview });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      replayCandidate.eventKey,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(previewSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(throttleStore).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![0]).toBeInstanceOf(Array);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });
  it("audit failure always refuses the dispatch", async () => {
    mocks.audit.mockRejectedValue(new Error("private audit failure"));
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(
      store,
      { headers: { cookie: await cookie(store) } },
      env,
      undefined,
      undefined,
      {
        loadCandidate: async () => replayCandidate,
        dispatch,
      },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
