// Acceptance contract: queue-redispatch throw legs warn (X3 leg A).
//
// Acceptance-owned: the Builder builds on this branch and never edits this file.
// Failing-first: the three "warns once" tests run RED on main (no warn is
// emitted today) and go green when the build lands. The silence + envelope
// controls already pass and must keep passing.
//
// Contract for the Builder (exact console.warn lines, each fired once):
//   1. Audit write throws (recordAttemptOrRefuse):
//      "Queue redispatch audit failed; refusing the dispatch."
//      { exception: queueExceptionClass(err), failure_id: <preview.failure.id> }
//   2. Candidate load throws:
//      "Queue redispatch candidate load failed."
//      { exception: queueExceptionClass(err), failure_id: <parsed id> }
//   3. Dispatch throws:
//      "Queue redispatch dispatch failed."
//      { exception: queueExceptionClass(err), failure_id: <candidate.preview.failure.id> }
// Envelopes + status codes are unchanged; the prerequisite refusal
// (missing queue/database with no dispatch seam) stays silent, as do the
// success, keep-refusal and unknown-id paths. Never log the exception
// message, SQL bindings or diagnostic payloads: class + failure id only.
//
// Hermetic: injected REDISPATCH_DEPS + a mocked postgres tag, the same seams
// as test/queue-redispatch-route.test.ts. The throttle seam returns a healthy
// in-memory store so this leg stays isolated from the throttle warn leg.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { RedispatchDeps } from "../src/admin/queue-redispatch";
import type { Env } from "../src/env";
import type { FailedJobReplayCandidate } from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import type { Sql } from "../src/sessions";
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

/** Healthy in-memory throttle store: admits everything, prunes cleanly, never warns. */
function healthyThrottleSql(): Sql {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) return [{ n: 0, wait: 1 }];
      if (statement.includes("INSERT INTO web_throttle_hits")) return [];
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: unknown) => Promise<unknown>) => run(sql),
      unsafe: async () => [],
    },
  );
  return sql as unknown as Sql;
}
const throttleStore = vi.fn(async () => healthyThrottleSql());

async function cookie(store: SessionStore): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: operator,
    username: "fixture",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
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
  bearer: string,
  deps: RedispatchDeps,
  bindings = env,
  path = "/admin/queue/failed/7/redispatch",
) {
  const app = new Hono().route("/admin", adminApp(store));
  return app.request(
    `${STAGING_APP_URL}${path}`,
    { method: "POST", headers: { origin: bindings.APP_URL, cookie: bearer } },
    { ...bindings, REDISPATCH_DEPS: deps, THROTTLE_STORE: throttleStore } as Env,
  );
}

function attemptOutcome(): string {
  const found = mocks.audit.mock.calls
    .flat()
    .find((v) => v && typeof v === "object" && !Array.isArray(v) && "outcome" in (v as object));
  return (found as { outcome: { after: string } }).outcome.after;
}

beforeEach(() => {
  mocks.audit.mockResolvedValue([]);
  mocks.end.mockResolvedValue(undefined);
  mocks.factory.mockImplementation(() =>
    Object.assign(mocks.audit, { json: (x: unknown) => x, end: mocks.end }),
  );
  throttleStore.mockImplementation(async () => healthyThrottleSql());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("redispatch throw legs warn once (failing-first)", () => {
  it("audit failure warns with the failure id and keeps the 503 envelope", async () => {
    mocks.audit.mockRejectedValue(new Error("private audit failure redispatch-audit-marker"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(store, await cookie(store), {
      loadCandidate: async () => replayCandidate,
      dispatch,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Queue redispatch audit failed; refusing the dispatch.",
      expect.objectContaining({ exception: "Error", failure_id: 7 }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("redispatch-audit-marker");
    expect(logged).not.toContain("private audit failure");
  });

  it("candidate-load failure warns with the failure id and writes no receipt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(store, await cookie(store), {
      loadCandidate: async () => {
        throw new Error("private SQL failure redispatch-candidate-marker");
      },
      dispatch,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Queue redispatch candidate load failed.",
      expect.objectContaining({ exception: "Error", failure_id: 7 }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("redispatch-candidate-marker");
    expect(logged).not.toContain("private SQL failure");
  });

  it("dispatch failure warns with the failure id and keeps the attempt receipt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => {
      throw new Error("private queue failure redispatch-dispatch-marker");
    });
    const res = await request(store, await cookie(store), {
      loadCandidate: async () => replayCandidate,
      dispatch,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(attemptOutcome()).toBe("attempted");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Queue redispatch dispatch failed.",
      expect.objectContaining({ exception: "Error", failure_id: 7 }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("redispatch-dispatch-marker");
    expect(logged).not.toContain("private queue failure");
  });
});

describe("redispatch silence + envelope stability", () => {
  it("success dispatches with no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(store, await cookie(store), {
      loadCandidate: async () => replayCandidate,
      dispatch,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redispatched: true, ...replayCandidate.preview });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(attemptOutcome()).toBe("attempted");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keep refusal answers 409 with no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(store, await cookie(store), {
      loadCandidate: async () => keepCandidate,
      dispatch,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "redispatch_refused",
      failure: keepCandidate.preview.failure,
      disposition: keepCandidate.preview.disposition,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(attemptOutcome()).toBe("refused");
    expect(warn).not.toHaveBeenCalled();
  });

  it("prerequisite refusal (no queue binding) stays a silent 503", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const res = await request(
      store,
      await cookie(store),
      { loadCandidate: async () => replayCandidate },
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("unknown id stays a silent 404 with no receipt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemorySessionStore();
    const dispatch = vi.fn(async () => true);
    const res = await request(store, await cookie(store), {
      loadCandidate: async () => null,
      dispatch,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "failure_not_found" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
