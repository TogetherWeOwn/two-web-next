// route-inventory: (none; service-level)
// Agent-events ingress replay/idempotency (nightly mutation E4/E7): pins the
// replay-before-budget order and the under-lock raced-replay recheck in
// `src/agent-events/ingress.ts` through `handleAgentEvent` with an in-memory
// fake store.
//
// A weakened check must be killed here:
// - E4 (`if (!replay)` to `if (false)`): a stored replay answers without
//   spending rate budget, even when the mutating budgets are spent.
// - E7 (`if (raced)` to `if (false)`): a concurrent store that lands while
//   the operation lock waits answers as a replay instead of re-executing.
// The fresh-create test proves the fake stores and returns without a replay
// flag, so a replay mutant that re-executes fails loudly.
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
import {
  DEFAULT_CONFIG,
  digest,
  handleAgentEvent,
  type IngressConfig,
} from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-replay-kill-001";
const GRANT_ID = "grant-replay-1";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled replay proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const GRANT = {
  id: GRANT_ID,
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
};

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the replay paths");
    }),
  );
}

describe("agent-events ingress replay (DB-free kill)", () => {
  it("a stored replay answers replayed without spending rate budget", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    // Spend the mutating budgets past every allowance; the shield bucket for
    // this credential stays empty so admission itself still passes.
    fake.prespend(`mutating:${GRANT_ID}`);
    fake.prespend("service-mutating");

    const body = { op: "create", idempotency_key: "replay-e4-001", fields: FIELDS };
    fake.seedReplay(GRANT_ID, "replay-e4-001", {
      payload_digest: await digest(body),
      status: 201,
      body: JSON.stringify({ event_key: "AAAAAAAAAAAAAAAAAAAAAAAAAA", status: "draft" }),
      event_key: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    const a = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ replayed: true });
  });

  it("a replay stored while the operation lock waits answers replayed", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);

    const body = { op: "create", idempotency_key: "replay-e7-001", fields: FIELDS };
    // The pre-lock lookup misses; the under-lock recheck finds the row a
    // concurrent call stored while this call waited on the operation lock.
    fake.armRace(GRANT_ID, "replay-e7-001", {
      payload_digest: await digest(body),
      status: 201,
      body: JSON.stringify({ event_key: "BBBBBBBBBBBBBBBBBBBBBBBBBB", status: "draft" }),
      event_key: "BBBBBBBBBBBBBBBBBBBBBBBBBB",
    });

    const a = await handleAgentEvent(fake.sql, cfg, body, CRED);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ replayed: true });
  });

  it("a fresh create stores and returns without a replay flag", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, GRANT);
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: "replay-ok-001", fields: FIELDS },
      CRED,
    );
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
  });
});
