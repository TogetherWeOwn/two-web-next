// route-inventory: POST /api/agent-events
// Agent-events ingress error alerts: both `src/agent-events/route.ts`
// catches page through `alertRequestError` (method POST, route
// `/api/agent-events`, the HTTP request id) before the DB-unavailable branch,
// while shield-refusal 4xx shapes stay silent.
//
// DB-free: mounted app with the in-memory fake agent-event store, no
// DATABASE_URL, no Discord, no network. Follows the route-refusal nightly
// contract: drive only through the mounted app (`test/app.ts`).
import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";
import { parseJsonLines } from "./helpers/parse-json-lines";

const CALLER = "agent-under-test";
const CRED = "cred-ingress-alert-001";

const baseEnv = {
  APP_URL: "https://next.example.test",
  AGENT_EVENTS_ENABLED: "true",
  AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
} as unknown as Env;

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

type AlertLine = {
  event: string;
  fingerprint: string;
  method: string;
  route: string;
  request_id?: string;
};

function alertLines(calls: unknown[][]): AlertLine[] {
  const { parsed, skipped } = parseJsonLines(calls);
  expect(skipped, `unparsed log lines: ${JSON.stringify(skipped)}`).toEqual([]);
  const out: AlertLine[] = [];
  for (const { value } of parsed) {
    const line = value as AlertLine;
    if (line.event === "error.alert") out.push(line);
  }
  return out;
}

async function grantEnv(): Promise<Env> {
  const fake = makeFakeAgentDb();
  await fake.addGrant(CRED, {
    id: "grant-ingress-alert-1",
    agent_id: CALLER,
    guild_id: DEFAULT_CONFIG.stagingGuildId,
    expires_at: null,
    disabled_at: null,
  });
  return { ...baseEnv, AGENT_EVENT_SQL: fake.sql } as unknown as Env;
}

/** Delegate every statement to the fake except the grant lookup, which throws. */
function sabotageGrantLookup(fakeSql: postgres.Sql, err: Error): postgres.Sql {
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("FROM agent_event_grants WHERE verifier_hash")) throw err;
    return (
      fakeSql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown[]>
    )(strings, ...values);
  }) as unknown as postgres.Sql;
  for (const key of ["unsafe", "end", "begin"] as const) {
    (run as unknown as Record<string, unknown>)[key] = (
      fakeSql as unknown as Record<string, unknown>
    )[key];
  }
  return run;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("agent-events ingress error alerts", () => {
  it("a thrown handler error answers 500 and emits one error.alert with the route", async () => {
    class HandlerBoomError extends Error {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the alert paths");
      }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-ingress-alert-500",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = {
      ...baseEnv,
      AGENT_EVENT_SQL: sabotageGrantLookup(fake.sql, new HandlerBoomError("boom")),
    } as unknown as Env;

    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op: "create", idempotency_key: "alert-500-001" }),
      },
      env,
      executionCtx,
    );

    expect(res.status).toBe(500);
    expect((await res.json()) as { reason: string }).toMatchObject({ reason: "internal_error" });
    const alerts = alertLines(spy.mock.calls);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      method: "POST",
      route: "/api/agent-events",
      fingerprint: "HandlerBoomError@/api/agent-events",
    });
    expect(typeof alerts[0]!.request_id).toBe("string");
  });

  it("a DB outage answers 503 and emits one error.alert with the route", async () => {
    class OutageBoomError extends Error {
      code = "ECONNREFUSED";
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the alert paths");
      }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-ingress-alert-503",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = {
      ...baseEnv,
      AGENT_EVENT_SQL: sabotageGrantLookup(fake.sql, new OutageBoomError("conn refused")),
    } as unknown as Env;

    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op: "create", idempotency_key: "alert-503-001" }),
      },
      env,
      executionCtx,
    );

    expect(res.status).toBe(503);
    expect((await res.json()) as { reason: string; message: string }).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is temporarily unavailable. Try again shortly.",
    });
    const alerts = alertLines(spy.mock.calls);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      method: "POST",
      route: "/api/agent-events",
      fingerprint: "OutageBoomError@/api/agent-events",
    });
    expect(typeof alerts[0]!.request_id).toBe("string");
  });

  it("a DB outage during admission answers 503 and emits one error.alert", async () => {
    class AdmissionOutageError extends Error {
      code = "ECONNREFUSED";
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the alert paths");
      }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outageSql = (async () => {
      throw new AdmissionOutageError("shield store down");
    }) as unknown as postgres.Sql;
    for (const key of ["unsafe", "end", "begin"] as const) {
      (outageSql as unknown as Record<string, unknown>)[key] = async () => {
        throw new AdmissionOutageError("shield store down");
      };
    }
    const env = { ...baseEnv, AGENT_EVENT_SQL: outageSql } as unknown as Env;

    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op: "create", idempotency_key: "alert-admit-503-001" }),
      },
      env,
      executionCtx,
    );

    expect(res.status).toBe(503);
    expect((await res.json()) as { reason: string; message: string }).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is temporarily unavailable. Try again shortly.",
    });
    const alerts = alertLines(spy.mock.calls);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      method: "POST",
      route: "/api/agent-events",
      fingerprint: "AdmissionOutageError@/api/agent-events",
    });
    expect(typeof alerts[0]!.request_id).toBe("string");
  });

  it("shield-refusal 4xx shapes stay silent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the route refusal paths");
      }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await grantEnv();

    const unauthenticated = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "create", idempotency_key: "alert-4xx-001" }),
      },
      env,
      executionCtx,
    );
    expect(unauthenticated.status).toBe(401);

    const forbidden = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op: "delete", idempotency_key: "alert-4xx-002" }),
      },
      env,
      executionCtx,
    );
    expect(forbidden.status).toBe(403);

    expect(alertLines(spy.mock.calls)).toHaveLength(0);
  });
});
