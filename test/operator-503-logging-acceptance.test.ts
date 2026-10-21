// route-inventory: GET /admin/queue/failed/:id/preview
// route-inventory: GET /admin/queue/source-evidence/:id
// Acceptance: silent operator-503 branches must log a joinable, leak-free line.
// Failing-first for the T4 observability build: each of the three catches
// (queue preview admission audit, queue preview handler source read, source
// evidence snapshot) currently answers 503 with no log line at all. After the
// build, each emits exactly the exception class + failure id, byte-stable bodies.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import * as previews from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  end: vi.fn(),
  factory: vi.fn(),
  texts: [] as string[],
  mode: "row" as "row" | "error",
}));
vi.mock("postgres", () => ({ default: mocks.factory }));

const operator = "100000000000000111";
const secret = "test-session-secret-at-least-32-bytes-long";
// Distinctive failure id so the joinable-field assertion cannot match a timestamp.
const FAILURE_ID = 987654;
const PREVIEW_PATH = `/admin/queue/failed/${FAILURE_ID}/preview`;
const EVIDENCE_PATH = `/admin/queue/source-evidence/${FAILURE_ID}`;

const queueEnv: Env = {
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

const evidenceToken = "test-source-evidence-bearer-token-with-32-plus-bytes-000";
const evidenceEnv: Env = {
  ...queueEnv,
  SOURCE_EVIDENCE_VERIFIER_ENABLED: "true",
  SOURCE_EVIDENCE_VERIFIER_TOKEN: evidenceToken,
  SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: String(FAILURE_ID),
  SOURCE_EVIDENCE_VERIFIER_ISSUED_AT: String(Date.now()),
  SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: String(Date.now() + 600_000),
};

// Distinctive markers: none may appear in any new log line.
const MSG_PROBE = "op503-msg-probe-7f3a21";
const SQL_PROBE = "op503-sql-probe-SELECT-secret-table-8b4c92";
const BINDING_PROBE = "op503-binding-probe-9d5e13";
const BODY_PROBE = "op503-body-probe-payload-4a6f87";
const URI_PROBE_PATH = "/admin/queue/failed";

class QueueHandlerProbeError extends Error {
  constructor() {
    super(`${MSG_PROBE} ${SQL_PROBE} binding=${BINDING_PROBE} body=${BODY_PROBE}`);
    this.name = "QueueHandlerProbeError";
  }
}
class QueueAuditProbeError extends Error {
  constructor() {
    super(`${MSG_PROBE}-audit ${SQL_PROBE}-audit binding=${BINDING_PROBE}-audit`);
    this.name = "QueueAuditProbeError";
  }
}
class EvidenceProbeError extends Error {
  constructor() {
    super(`${MSG_PROBE}-evidence ${SQL_PROBE}-evidence binding=${BINDING_PROBE}-evidence`);
    this.name = "EvidenceProbeError";
  }
}

const sample: previews.FailedJobPreview = {
  failure: {
    id: FAILURE_ID,
    kind: "sync-event",
    failedAt: "2026-10-07T00:00:00.000Z",
  },
  observedAt: "2026-10-07T01:00:00.000Z",
  disposition: { action: "discard-stale", reason: `clean; ${BODY_PROBE}` },
};

async function operatorCookie(store: SessionStore) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: operator,
    username: "fixture",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600000),
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

function previewRequest(store: SessionStore, init: RequestInit = {}, bindings = queueEnv) {
  const app = new Hono().route("/admin", adminApp(store));
  return app.request(
    `${STAGING_APP_URL}${PREVIEW_PATH}`,
    { ...init, headers: { origin: bindings.APP_URL, ...init.headers } },
    bindings,
  );
}

function evidenceRequest(store: SessionStore, init: RequestInit = {}, bindings = evidenceEnv) {
  const app = new Hono().route("/admin", adminApp(store));
  return app.request(
    `${STAGING_APP_URL}${EVIDENCE_PATH}`,
    {
      ...init,
      headers: { authorization: `Bearer ${evidenceToken}`, ...init.headers },
    },
    bindings,
  );
}

/** All console output emitted during the request, across warn and error levels. */
function loggedText(warn: { mock: { calls: unknown[][] } }, err: { mock: { calls: unknown[][] } }) {
  return JSON.stringify([...warn.mock.calls, ...err.mock.calls]);
}

function expectJoinableLine(logged: string, exceptionClass: string, label: string) {
  expect(logged, `${label} must log the exception class ${exceptionClass}`).toContain(
    exceptionClass,
  );
  expect(logged, `${label} must log the failure id ${FAILURE_ID} for joinability`).toContain(
    String(FAILURE_ID),
  );
}

function expectNoLeaks(logged: string, label: string, extraMarkers: string[] = []) {
  for (const marker of [MSG_PROBE, SQL_PROBE, BINDING_PROBE, BODY_PROBE, ...extraMarkers]) {
    expect(logged, `${label} must not leak marker ${marker}`).not.toContain(marker);
  }
  // The full request path must not be echoed even though the numeric id is logged.
  expect(logged, `${label} must not echo the request URI`).not.toContain(URI_PROBE_PATH);
  expect(logged, `${label} must not echo the staging origin`).not.toContain(STAGING_APP_URL);
}

describe("operator 503 logging acceptance", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.audit.mockResolvedValue([]);
    mocks.end.mockResolvedValue(undefined);
    mocks.texts.length = 0;
    mocks.mode = "row";
    mocks.factory.mockImplementation(() =>
      Object.assign(mocks.audit, { json: (x: unknown) => x, end: mocks.end }),
    );
    vi.spyOn(previews, "previewFailedJob").mockResolvedValue(sample);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("queue preview handler source failure logs exception class + failure id, body byte-stable", async () => {
    vi.mocked(previews.previewFailedJob).mockRejectedValue(new QueueHandlerProbeError());
    const store = createMemorySessionStore();
    const res = await previewRequest(store, {
      headers: { cookie: await operatorCookie(store) },
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "preview_unavailable" }));
    expect(await res.headers.get("content-type")).toContain("application/json");
    const logged = loggedText(warn, err);
    expectJoinableLine(logged, "QueueHandlerProbeError", "handler 503");
    expectNoLeaks(logged, "handler 503");
    expect(logged).not.toContain("preview_unavailable");
  });

  it("queue preview admission audit failure logs exception class + failure id, body byte-stable", async () => {
    mocks.audit.mockRejectedValue(new QueueAuditProbeError());
    const store = createMemorySessionStore();
    const res = await previewRequest(
      store,
      { headers: { cookie: await operatorCookie(store) } },
      { ...queueEnv, MEMBER_ACCESS_LOG_ENFORCE: "true" },
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "preview_unavailable" }));
    const logged = loggedText(warn, err);
    expectJoinableLine(logged, "QueueAuditProbeError", "admission 503");
    expectNoLeaks(logged, "admission 503", [`${MSG_PROBE}-audit`]);
    expect(logged).not.toContain("preview_unavailable");
  });

  it("source evidence snapshot failure logs exception class + failure id, body byte-stable", async () => {
    mocks.factory.mockImplementation(() => {
      const tag = () => {
        throw new EvidenceProbeError();
      };
      return Object.assign(tag, {
        begin: async (_mode: string, work: (tx: unknown) => unknown) => work(tag),
        end: mocks.end,
      });
    });
    const res = await evidenceRequest(createMemorySessionStore());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "evidence_unavailable" }));
    const logged = loggedText(warn, err);
    expectJoinableLine(logged, "EvidenceProbeError", "evidence 503");
    expectNoLeaks(logged, "evidence 503", [`${MSG_PROBE}-evidence`]);
    expect(logged).not.toContain("evidence_unavailable");
  });

  it("queue preview success stays silent on the new lines and keeps the 200 shape", async () => {
    const store = createMemorySessionStore();
    const res = await previewRequest(store, {
      headers: { cookie: await operatorCookie(store) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ previewOnly: true, ...sample });
    const logged = loggedText(warn, err);
    expect(logged).not.toContain("QueueHandlerProbeError");
    expect(logged).not.toContain("QueueAuditProbeError");
  });

  it("source evidence success stays silent on the new lines", async () => {
    // Minimal live-shaped snapshot: the route needs five source reads with markers.
    const at = new Date();
    mocks.factory.mockImplementation(() => {
      const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const text = strings.join("?");
        if (text.trim().startsWith(", clock_timestamp()")) return {};
        if (text.includes("set_config")) return [];
        if (
          text.includes("current_setting") &&
          !text.includes("queue_failed_jobs") &&
          !text.includes("events")
        ) {
          return [{ lock_timeout: "17s", statement_timeout: "23s" }];
        }
        mocks.texts.push(text);
        if (text.includes("queue_failed_jobs")) {
          return [
            {
              id: FAILURE_ID,
              kind: "sync-event",
              key: "sync-event:01ARZ3NDEKTSV4RRFFQ69G5FAA",
              failed_at: at,
              observed_at: at,
              preview_read_at: at,
            },
          ];
        }
        if (text.includes("rejected") || text.includes("pending") || text.includes("a.state"))
          return [];
        if (text.includes("from events")) return [{ preview_read_at: new Date() }];
        return [];
      };
      const tx = Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => tag(strings, ...values),
        {
          savepoint: async <T>(work: (c: unknown) => Promise<T>) => work(tx),
        },
      );
      return Object.assign(tag, {
        begin: (...args: unknown[]) => (args[args.length - 1] as (t: unknown) => unknown)(tx),
        end: mocks.end,
      });
    });
    const res = await evidenceRequest(createMemorySessionStore());
    expect(res.status).toBe(200);
    const logged = loggedText(warn, err);
    expect(logged).not.toContain("EvidenceProbeError");
  });
});
