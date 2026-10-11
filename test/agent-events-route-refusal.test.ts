// route-inventory: POST /api/agent-events
// Agent-events route refusal (nightly mutation G1/G2/G3): pins the
// `src/agent-events/route.ts` refusal paths through the mounted app with no
// database behind them.
//
// A weakened check must be killed here:
// - G1 (`if (!cfg.enabled)` to `if (false)`): a disabled ingress stays 404
//   and never reaches the store seam.
// - G2 (`if (!injected && !url)` to `if (false)`): an enabled ingress with
//   no store stays 503 instead of proceeding onto an unconfigured client.
// - G3 (bearer `return m ? m[1] : null` to `return null`): a valid bearer
//   still authenticates, so an unknown op stays 403, not 401.
// The final create test proves the admitted path reaches the service (201)
// through the injected fake, so a refusal mutant that closes it fails loudly.
//
// Hermetic and DB-free: mounted app with an in-memory fake agent-event store
// and stubbed fetch only, no DATABASE_URL, no Discord, no database. Matches
// the sessions-join nightly contract exactly.
//
// Scope guard: must not import `src/agent-events/route.ts` bearer internals
// or `src/agent-events/ingress.ts` directly; drive only through the mounted
// app (`test/app.ts`) with minimal env.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const CRED = "cred-route-kill-001";

const baseEnv = {
  APP_URL: "https://next.example.test",
} as unknown as Env;

const enabledEnv = {
  ...baseEnv,
  AGENT_EVENTS_ENABLED: "true",
  AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
} as unknown as Env;

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled route proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the route refusal paths");
    }),
  );
}

// Stub executionCtx so a kill cannot come from the harness crashing in the
// route's `finally` (route.ts): the verdict must come from the assertion.
const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

describe("agent-events route refusal (DB-free kill)", () => {
  it("a disabled ingress answers 404 without touching a store", async () => {
    noFetch();
    const res = await app.request(
      "/api/agent-events",
      { method: "POST", body: "{}" },
      baseEnv,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "ingress_disabled",
    });
  });

  it("an enabled ingress with no store answers 503", async () => {
    noFetch();
    const res = await app.request(
      "/api/agent-events",
      { method: "POST", body: "{}" },
      enabledEnv,
      executionCtx,
    );
    expect(res.status).toBe(503);
    // Pin the not-configured message, not just the reason: a G2 mutant
    // (`if (!injected && !url)` to `if (false)`) dials postgres(undefined),
    // which maps ECONNREFUSED to the same reason with a different message.
    expect((await res.json()) as { reason: string; message: string }).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is not configured.",
    });
  });

  it("a valid bearer with an unknown op stays 403, not 401", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-route-1",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = { ...enabledEnv, AGENT_EVENT_SQL: fake.sql } as unknown as Env;
    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op: "delete", idempotency_key: "route-g3-001" }),
      },
      env,
      executionCtx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "forbidden_action",
    });
  });

  it("a valid bearer create reaches the service through the injected store", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: "grant-route-2",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const env = { ...enabledEnv, AGENT_EVENT_SQL: fake.sql } as unknown as Env;
    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRED}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          op: "create",
          idempotency_key: "route-ok-001",
          fields: FIELDS,
        }),
      },
      env,
      executionCtx,
    );
    expect(res.status).toBe(201);
  });
});
