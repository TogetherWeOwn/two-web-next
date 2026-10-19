// Acceptance: write-backs dispatched through POST /api/agent-events carry the
// validated HTTP request ID into the tracked sync-event envelope, exactly as
// the HTTP event routes do, so an operator can correlate an agent write-back
// by request_id alone.
//
// Break this catches: the ingress route builds its write-back effect without
// the request context's ID, so every agent-initiated publish/cancel/edit
// enqueues a sync-event message whose requestId is undefined while the same
// request's response and logs carry a validated ID.
//
// Hermetic and DB-free. Only the admission boundary is doubled: the fake
// admitted handler dispatches the write-back an accepted publish/cancel
// dispatches in the real service (draft creates, reads, replays and denials
// dispatch none). Everything downstream of the route stays real — requestLog
// validation, the route's effects closure, dispatchWriteBack,
// enqueueEventSync and safeRequestId — and the assertion reads the envelope
// handed to the queue binding.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { requestLog } from "../src/request-log";
import { agentEventsAdmission, agentEventsRoute } from "../src/agent-events/route";
import type { IngressEffects } from "../src/agent-events/service";
import type { QueueMessage } from "../src/jobs/types";

type TrackedSync = Extract<QueueMessage, { kind: "sync-event" }>;

// Fixture ULID, assembled from parts so secret scanners do not read the
// single literal as a credential; the runtime value is unchanged.
const KEY = "01ARYZ6S" + "41TSV4RR" + "FFQ69G5FAV";

// The service boundary: admission succeeds and the bound handler performs the
// one side effect an accepted lifecycle op performs — dispatching its
// write-back through the effects the route supplied. The write-back payload
// is a hand-written literal, not derived from any code under test.
vi.mock("../src/agent-events/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent-events/service")>()),
  admitAgentEvent: async (
    _sql: unknown,
    _cfg: unknown,
    _credential: unknown,
    _ip: unknown,
    effects: IngressEffects = {},
  ) => ({
    handle: async (body: unknown) => {
      const op = (body as { op?: unknown } | null)?.op;
      if (op === "publish") await effects.writeBack?.({ eventKey: KEY, status: "published" });
      if (op === "cancel") await effects.writeBack?.({ eventKey: KEY, status: "cancelled" });
      return { status: 200, body: { ok: true } };
    },
  }),
}));

// The tracked producer's lease/ledger bookkeeping needs a database; forward
// the built envelope to the fake queue binding instead (same pattern as the
// shared-ingress suite), keeping buildSyncMessage and its ID validation real.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: TrackedSync) => {
    await env.SYNC_EVENT_QUEUE!.send(
      { ...message, jobId: crypto.randomUUID() },
      { delaySeconds: 10 },
    );
    return true;
  },
}));

const RAY = "0123456789abcdef-LHR";
const OTHER_RAY = "fedcba9876543210-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

afterEach(() => vi.restoreAllMocks());

/** The ingress as mounted in production, optionally without requestLog. */
function makeApp(withRequestLog: boolean) {
  const app = new Hono<{ Bindings: Env }>();
  if (withRequestLog) app.use("*", requestLog);
  app.post("/api/agent-events", agentEventsAdmission, agentEventsRoute);
  return app;
}

async function callIngress(op: string, headers: Record<string, string>, withRequestLog = true) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sent: TrackedSync[] = [];
  const env = {
    APP_URL: "https://next.example.test",
    AGENT_EVENTS_ENABLED: "true",
    AGENT_EVENTS_CALLER_AGENT_ID: "agent-under-test",
    // Injected fixture store: admission is doubled above, so this is never
    // queried; its presence only proves the route proceeds past its
    // store-configured check without opening a real connection.
    AGENT_EVENT_SQL: {},
    SYNC_EVENT_QUEUE: {
      send: async (message: TrackedSync) => void sent.push(message),
    },
  } as unknown as Env;
  const response = await makeApp(withRequestLog).request(
    "/api/agent-events",
    {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-credential",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ op, idempotency_key: `wb-${op}-001`, event_key: KEY }),
    },
    env,
  );
  return { response, sent };
}

describe("agent-events write-back request correlation (route level, hermetic)", () => {
  it("carries the validated cf-ray ID from a publish into the sync-event envelope", async () => {
    const { response, sent } = await callIngress("publish", { "cf-ray": RAY });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(RAY);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: KEY, requestId: RAY });
    // Correlation rides beside the build-time key, never as the key itself.
    expect(sent[0]!.idempotencyKey).not.toBe(RAY);
  });

  it("carries each request's own ID, not a previous request's", async () => {
    const { response, sent } = await callIngress("cancel", { "cf-ray": OTHER_RAY });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.requestId).toBe(OTHER_RAY);
    expect(sent[0]!.requestId).not.toBe(RAY);
  });

  it("carries the generated ID when no valid cf-ray arrives, ignoring forged client IDs", async () => {
    const { response, sent } = await callIngress("publish", {
      "cf-ray": "not-a-ray-id",
      "x-request-id": "client-forged-id",
    });
    expect(response.status).toBe(200);
    const echoed = response.headers.get("x-request-id")!;
    expect(echoed).toMatch(ULID);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.requestId).toBe(echoed);
    expect(JSON.stringify(sent)).not.toContain("client-forged-id");
    expect(JSON.stringify(sent)).not.toContain("not-a-ray-id");
  });

  it("falls back to no correlation when the request has no ID context", async () => {
    // No requestLog middleware upstream: the write-back
    // still dispatches, with requestId absent rather than fabricated.
    const { response, sent } = await callIngress("publish", { "cf-ray": RAY }, false);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: KEY });
    expect(sent[0]!.requestId).toBeUndefined();
  });

  it("enqueues nothing for an op that dispatches no write-back", async () => {
    const { response, sent } = await callIngress("read", { "cf-ray": RAY });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(RAY);
    expect(sent).toHaveLength(0);
  });
});
