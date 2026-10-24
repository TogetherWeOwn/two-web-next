// Agent ingress answers over-deep bodies with a static 422 message.
//
// Pins the decoupling between the internal digest error and the public API
// contract: the digest throws a distinct internal diagnostic (never the API
// constant), and the ingress answers the static constant verbatim instead of
// echoing `err.message`. Reverting the ingress to `err.message` answers the
// internal text and fails the contract pin; drifting the throw site back to
// the API literal fails the separation pin.
//
// Hermetic and DB-free: real digest plus `handleAgentEvent` against the
// in-memory fake store. No DATABASE_URL, no Discord, no network.
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  DEFAULT_CONFIG,
  digest,
  handleAgentEvent,
  PAYLOAD_TOO_DEEP_MESSAGE,
  PayloadTooDeepError,
  type IngressConfig,
} from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const GRANTED = "cred-deep-static-001";
const liveGrant = (): FakeGrant => ({
  id: "grant-deep-static-1",
  agent_id: "agent-under-test",
  guild_id: DEFAULT_CONFIG.stagingGuildId,
  expires_at: null,
  disabled_at: null,
});

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: "agent-under-test",
  lockWaitMs: 50,
  routePerMinute: 60,
};

const deepBody = () => {
  const body: Record<string, unknown> = { op: "create", idempotency_key: "deep-static-001" };
  let cur = body;
  for (let i = 0; i < 500; i++) {
    const nxt: Record<string, unknown> = {};
    cur.nest = nxt;
    cur = nxt;
  }
  return body;
};

afterEach(() => vi.unstubAllGlobals());

describe("agent ingress over-deep body answers a static 422 message (DB-free)", () => {
  it("the digest throws a typed error whose text stays distinct from the API contract", async () => {
    let err: unknown = null;
    try {
      await digest(deepBody());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PayloadTooDeepError);
    // Separation pin: the internal diagnostic must never equal the public
    // message, so echoing `err.message` cannot answer the contract by accident.
    expect((err as Error).message).not.toBe(PAYLOAD_TOO_DEEP_MESSAGE);
  });

  it("the ingress answers the static message, never the caught error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch must not be called on the payload_too_deep path");
      }),
    );
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const r = await handleAgentEvent(fake.sql, cfg, deepBody(), GRANTED, "127.0.0.32");
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe("payload_too_deep");
    expect(r.body.message).toBe(PAYLOAD_TOO_DEEP_MESSAGE);
    expect(r.body.message).toBe("The request body nests deeper than 100 levels.");
  });
});
