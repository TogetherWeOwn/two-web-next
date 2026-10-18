// Inner 429 audit correlation: the 429 body's request_id equals the
// denied/rate_limited audit row's request_id for the same admission.
//
// Companion to the acceptance contract in
// test/agent-events-ingress-429-request-id-acceptance.test.ts (owned by the
// Test Author, never edited here): that file pins the envelope shape and ID
// presence/distinctness, while this file pins the correlation the PR exists
// for — an operator holding a throttled response can tie it to the audit row.
// Hermetic and DB-free via the in-memory fake agent-event store.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-429-audit-correlation-001";
const GRANT_ID = "grant-429-audit-correlation-1";

const cfg = (): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
  routePerMinute: 60,
});

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled 429 audit-correlation proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

let n = 0;

describe("inner 429 request_id matches its audit row", () => {
  it.each([
    ["per-grant mutating bucket", `mutating:${GRANT_ID}`],
    ["whole-service mutating bucket", "service-mutating"],
  ])("spent %s audits the refusal under the response ID", async (_name, bucket) => {
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, {
      id: GRANT_ID,
      agent_id: CALLER,
      guild_id: STAGING,
      expires_at: null,
      disabled_at: null,
    });
    fake.prespend(bucket);
    const answer = await handleAgentEvent(
      fake.sql,
      cfg(),
      { op: "create", idempotency_key: `ingress-429-audit-correlation-${++n}`, fields: FIELDS },
      CRED,
    );

    expect(answer.status).toBe(429);
    expect(typeof answer.body.request_id).toBe("string");
    expect((answer.body.request_id as string).length).toBeGreaterThan(0);

    // The refusal is audited once as denied/rate_limited under the same ID.
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      operation: "create",
      result: "denied",
      reason: "rate_limited",
      requestId: answer.body.request_id,
    });
  });
});
