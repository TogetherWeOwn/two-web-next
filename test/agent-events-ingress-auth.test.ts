// route-inventory: (none; service-level)
// Agent-events ingress auth admission (nightly mutation E1/E2/E3/E5/E6): pins
// `src/agent-events/ingress.ts` admission through `handleAgentEvent` against
// an in-memory fake store.
//
// A weakened check must be killed here:
// - E1 (`if (!grant)` to `if (false)`): anonymous hits stay 401.
// - E2 (caller check to `if (false)`): a foreign agent stays 403 wrong_caller.
// - E3 (staging-guild check to `if (false)`): a foreign guild stays 403.
// - E5 (envelope check to `if (false)`): a keyless envelope stays 422.
// - E6 (op allowlist to `if (false)`): an unknown op stays 403.
// The final create test proves the fake admits a well-formed call (201), so a
// bypass mutant that turns a 403 above into a 201 fails loudly.
//
// Hermetic and DB-free: in-memory fake agent-event store + stubbed fetch
// only, no DATABASE_URL, no Discord, no database. Matches the sessions-join
// nightly contract exactly.
//
// Scope guard: must not import `src/agent-events/grants.ts`,
// `src/agent-events/shield.ts`, `src/agent-events/rate-limit.ts` or
// `src/agent-events/idempotency.ts` directly; drive only through the public
// `handleAgentEvent` with the fake Sql double.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-auth-kill-001";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled auth proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const liveGrant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant-auth-1",
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("fetch must not be called on the ingress denial paths");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("agent-events ingress auth admission (DB-free kill)", () => {
  it("an anonymous hit with an unknown op stays 401, never reaching the op check", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "delete", idempotency_key: "auth-e1-001" },
      null,
    );
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated" });
  });

  it("a grant that is not the admitted caller stays 403", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ id: "grant-auth-2", agent_id: "some-other-agent" }));
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: "auth-e2-001", fields: FIELDS },
      CRED,
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_caller" });
  });

  it("a grant outside the staging guild stays 403", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ id: "grant-auth-3", guild_id: "other-guild" }));
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: "auth-e3-001", fields: FIELDS },
      CRED,
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "wrong_audience" });
  });

  it("an envelope without an op stays 422 before auth is consulted", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ id: "grant-auth-5" }));
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { idempotency_key: "auth-e5-001", fields: FIELDS },
      CRED,
    );
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ reason: "validation_failed" });
  });

  it("an unknown op stays 403 after auth", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ id: "grant-auth-6" }));
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "delete", idempotency_key: "auth-e6-001" },
      CRED,
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "forbidden_action" });
  });

  it("a well-formed create from the admitted caller reaches 201", async () => {
    const fetch = noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ id: "grant-auth-ok" }));
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: "auth-ok-001", fields: FIELDS },
      CRED,
    );
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
    expect(fetch).not.toHaveBeenCalled();
  });
});
