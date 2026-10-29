// route-inventory: POST /api/agent-events
// Acceptance: the four pre-service (middleware-level) refusals of the
// agent-events ingress carry the HTTP request id in the response body as
// `request_id`, matching the response's `x-request-id` header — exactly as
// service-level refusals already carry a request id — so an operator can
// correlate a refused machine call to its `http.request` log line from the
// body alone.
//
// The four refusals, all answered before the service runs:
// - ingress disabled: 404 `ingress_disabled`
// - store not configured: 503 `ingress_unavailable` ("not configured")
// - store unreachable during admission: 503 `ingress_unavailable`
//   ("temporarily unavailable")
// - store unreachable in the admitted handler: 503 `ingress_unavailable`
//   ("temporarily unavailable")
//
// Break this catches: the route answers those four refusals with only
// `{ reason, message }`, so the caller-visible body has no correlation id
// even though the request context already holds a validated one (the
// outermost request logger mints/validates it and echoes it as the
// `x-request-id` header). A client-supplied `x-request-id` must never be
// the source: the body's id is the validated/generated one.
//
// Positive controls (must pass before and after): each refusal keeps its
// status, reason and message; the `x-request-id` header keeps carrying the
// validated id; the admitted path still reaches the service and its
// service-level refusal shape is unchanged; no refusal body adds credential,
// driver or request-body bytes.
//
// Hermetic and DB-free: mounted app (`test/app.ts`) with the in-memory fake
// agent-event store and stubbed fetch only, no DATABASE_URL, no Discord,
// no database. Follows the route-refusal / ingress-alerts nightly contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const CRED = "cred-pre-service-rid-001";
const RAY = "0123456789abcdef-LHR";
const OTHER_RAY = "fedcba9876543210-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

type RefusalBody = { reason: string; message: string; request_id?: string };

const disabledEnv = {
  APP_URL: "https://next.example.test",
} as unknown as Env;

const enabledEnv = {
  APP_URL: "https://next.example.test",
  AGENT_EVENTS_ENABLED: "true",
  AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
} as unknown as Env;

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function silence() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the pre-service refusal paths");
    }),
  );
}

async function post(env: Env, headers: Record<string, string> = {}, body = "{}") {
  const res = await app.request(
    "/api/agent-events",
    { method: "POST", headers, body },
    env,
    executionCtx,
  );
  return { res, body: (await res.json()) as RefusalBody };
}

class OutageError extends Error {
  code = "ECONNREFUSED";
}

/** Every statement fails as unreachable: admission never binds a handler. */
function admissionOutageSql(): postgres.Sql {
  const run = (async () => {
    throw new OutageError("shield store down");
  }) as unknown as postgres.Sql;
  for (const key of ["unsafe", "end", "begin"] as const) {
    (run as unknown as Record<string, unknown>)[key] = async () => {
      throw new OutageError("shield store down");
    };
  }
  return run;
}

/** Admission succeeds against the fake; the handler's grant lookup fails. */
function handlerOutageSql(fakeSql: postgres.Sql): postgres.Sql {
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("FROM agent_event_grants WHERE verifier_hash")) {
      throw new OutageError("grant store down");
    }
    return (
      fakeSql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown[]>
    )(strings, ...values);
  }) as unknown as postgres.Sql;
  for (const key of ["unsafe", "end"] as const) {
    (run as unknown as Record<string, unknown>)[key] = (
      fakeSql as unknown as Record<string, unknown>
    )[key];
  }
  // Keep fault injection on the grant lookup inside its bounded transaction.
  (run as unknown as { begin: unknown }).begin = async (
    fn: (tx: postgres.Sql) => Promise<unknown>,
  ) => fn(run);
  return run;
}

async function grantedEnv(sql: postgres.Sql): Promise<Env> {
  return { ...enabledEnv, AGENT_EVENT_SQL: sql } as unknown as Env;
}

const authBody = JSON.stringify({ op: "create", idempotency_key: "pre-service-rid-001" });
const authHeaders = {
  authorization: `Bearer ${CRED}`,
  "content-type": "application/json",
  "cf-ray": RAY,
};

describe("pre-service ingress refusals carry request_id: positive controls", () => {
  it("a disabled ingress stays 404 ingress_disabled with the header id", async () => {
    silence();
    const { res, body } = await post(disabledEnv, { "cf-ray": RAY });
    expect(res.status).toBe(404);
    expect(body).toMatchObject({
      reason: "ingress_disabled",
      message: "The agent event ingress is not enabled in this environment.",
    });
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });

  it("an enabled ingress with no store stays 503 not-configured with the header id", async () => {
    silence();
    const { res, body } = await post(enabledEnv, { "cf-ray": RAY });
    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is not configured.",
    });
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });

  it("a store outage during admission stays 503 temporarily-unavailable", async () => {
    silence();
    const env = await grantedEnv(admissionOutageSql());
    const { res, body } = await post(env, authHeaders, authBody);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is temporarily unavailable. Try again shortly.",
    });
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });

  it("a store outage in the admitted handler stays 503 temporarily-unavailable", async () => {
    silence();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-pre-service-rid-handler",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = await grantedEnv(handlerOutageSql(fake.sql));
    const { res, body } = await post(env, authHeaders, authBody);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is temporarily unavailable. Try again shortly.",
    });
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });

  it("the admitted path still reaches the service with its shape unchanged", async () => {
    silence();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-pre-service-rid-admitted",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = await grantedEnv(fake.sql);
    const { res, body } = await post(
      env,
      authHeaders,
      JSON.stringify({ op: "delete", idempotency_key: "pre-service-rid-002" }),
    );
    // Service-level refusal: unchanged by this work. Its request_id is the
    // service-minted correlation id; only its presence/shape is pinned here.
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ reason: "forbidden_action" });
    expect(typeof body.request_id).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(RAY);
  });
});

describe("pre-service ingress refusals carry request_id: new behavior", () => {
  it("the disabled 404 body request_id matches the x-request-id header", async () => {
    silence();
    const { res, body } = await post(disabledEnv, { "cf-ray": RAY });
    expect(res.status).toBe(404);
    expect(body.request_id).toBe(RAY);
    expect(body.request_id).toBe(res.headers.get("x-request-id"));
    expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "reason", "request_id"]);
  });

  it("the not-configured 503 body request_id matches the x-request-id header", async () => {
    silence();
    const { res, body } = await post(enabledEnv, { "cf-ray": RAY });
    expect(res.status).toBe(503);
    expect(body.request_id).toBe(RAY);
    expect(body.request_id).toBe(res.headers.get("x-request-id"));
    expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "reason", "request_id"]);
  });

  it("the admission-outage 503 body request_id matches the header, leaking nothing", async () => {
    silence();
    const env = await grantedEnv(admissionOutageSql());
    const { res, body } = await post(env, authHeaders, authBody);
    expect(res.status).toBe(503);
    expect(body.request_id).toBe(RAY);
    expect(body.request_id).toBe(res.headers.get("x-request-id"));
    expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "reason", "request_id"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(CRED);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("shield store down");
  });

  it("the handler-outage 503 body request_id matches the header, leaking nothing", async () => {
    silence();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-pre-service-rid-handler-new",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = await grantedEnv(handlerOutageSql(fake.sql));
    const { res, body } = await post(env, authHeaders, authBody);
    expect(res.status).toBe(503);
    expect(body.request_id).toBe(RAY);
    expect(body.request_id).toBe(res.headers.get("x-request-id"));
    expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "reason", "request_id"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(CRED);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("grant store down");
  });

  it("carries each request's own id, not a previous request's", async () => {
    silence();
    const first = await post(disabledEnv, { "cf-ray": RAY });
    const second = await post(disabledEnv, { "cf-ray": OTHER_RAY });
    expect(first.body.request_id).toBe(RAY);
    expect(second.body.request_id).toBe(OTHER_RAY);
    expect(second.body.request_id).not.toBe(first.body.request_id);
  });

  it("ignores a forged client x-request-id and carries the generated id", async () => {
    silence();
    const { res, body } = await post(disabledEnv, {
      "cf-ray": "not-a-ray-id",
      "x-request-id": "client-forged-id",
    });
    expect(res.status).toBe(404);
    const echoed = res.headers.get("x-request-id")!;
    expect(echoed).toMatch(ULID);
    expect(body.request_id).toBe(echoed);
    expect(JSON.stringify(body)).not.toContain("client-forged-id");
    expect(JSON.stringify(body)).not.toContain("not-a-ray-id");
  });
});
