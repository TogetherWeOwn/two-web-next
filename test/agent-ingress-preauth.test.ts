// route-inventory: (none; service-level)
// Acceptance: authenticate the grant before hashing; refuse pre-auth cheaply.
//
// Contract under test:
// - Credential/grant resolution precedes the recursive payload digest.
//   Unknown or missing grants are refused (401 `unauthenticated`, the
//   existing envelope) without hashing the body: an over-deep grantless body
//   is answered 401, never 422 `payload_too_deep`, and a nested payload
//   probe is never traversed.
// - Pre-auth refusals insert zero audit rows. Table growth per
//   unauthenticated hit is zero (a sampled warn log is the builder's
//   choice and is deliberately not pinned here; the audit table is).
// - Authenticated oversized/deep payloads keep the existing 422
//   `payload_too_deep` plus exactly one audit row, now attributed to the
//   resolved grant. Admission, idempotency and shield semantics are
//   unchanged: the shield still counts every hit (including grantless
//   ones) and a spent bucket still refuses 429 first.
//
// Order left to the builder, pinned only on audit growth: for a grantless
// malformed envelope or a grantless hit on a disabled ingress, whether the
// cheap envelope/disabled refusal or the 401 wins is an implementation
// choice — either status passes, but neither may write an audit row.
//
// Driven hermetically through `handleAgentEvent` against the in-memory
// fake store: no DATABASE_URL, no Discord, no network. "No digest work"
// is observed without timing: (a) an over-deep body can only answer
// `payload_too_deep` if the recursive digest ran, and (b) a Proxy-wrapped
// nested payload counts every traversal trap the digest sets off. The
// granted Proxy control proves the probe registers traversal when the
// digest legitimately runs, so a zero count on the grantless paths is
// evidence, not a dead instrument.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const GRANTED = "cred-granted-001";
const UNKNOWN = "cred-unknown-001";
const GRANT_ID = "grant-preauth-1";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Agent pre-auth proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled pre-auth proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const liveGrant = (overrides: Partial<FakeGrant> = {}): FakeGrant => ({
  id: GRANT_ID,
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
  ...overrides,
});

let seq = 0;
const key = () => `preauth-${++seq}`;

/** Valid top-level envelope whose `nest` chain is `depth` objects deep. */
const deepBody = (depth = 500) => {
  const body: Record<string, unknown> = { op: "create", idempotency_key: key(), fields: FIELDS };
  let cur = body;
  for (let i = 0; i < depth; i++) {
    const nxt: Record<string, unknown> = {};
    cur.nest = nxt;
    cur = nxt;
  }
  return body;
};

/** Valid envelope whose `fields` hides an over-deep array chain. */
const deepArrayBody = () => {
  let arr: unknown[] = [];
  for (let i = 0; i < 500; i++) arr = [arr];
  return { op: "create", idempotency_key: key(), fields: arr };
};

/** Nested payload probe: counts every read/enumeration trap traversal. */
const countingFields = () => {
  const state = { traversals: 0 };
  const fields = new Proxy(
    { ...FIELDS },
    {
      get(target, prop, receiver) {
        state.traversals += 1;
        return Reflect.get(target, prop, receiver);
      },
      ownKeys(target) {
        state.traversals += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        state.traversals += 1;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    },
  );
  return {
    body: { op: "create", idempotency_key: key(), fields },
    traversals: () => state.traversals,
  };
};

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("fetch must not be called on the ingress paths");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("pre-auth refusals: no digest, no audit row (failing-first)", () => {
  it("a missing credential with an over-deep body is 401, never payload_too_deep, with zero audits", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const a = await handleAgentEvent(fake.sql, cfg, deepBody(), null);
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated" });
    expect(a.body.request_id).toBeTruthy();
    expect(fake.audits).toHaveLength(0);
    // Shield semantics unchanged: the hit is still counted.
    expect(fake.hits).toHaveLength(1);
  });

  it.each([150, 500])(
    "an unknown credential with a %i-deep body is 401 with zero audits",
    async (depth) => {
      noFetch();
      const fake = makeFakeAgentDb();
      const a = await handleAgentEvent(fake.sql, cfg, deepBody(depth), UNKNOWN);
      expect(a.status).toBe(401);
      expect(a.body).toMatchObject({ reason: "unauthenticated" });
      expect(fake.audits).toHaveLength(0);
      expect(fake.hits).toHaveLength(1);
    },
  );

  it("a missing credential with an over-deep array body is 401 with zero audits", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const a = await handleAgentEvent(fake.sql, cfg, deepArrayBody(), null);
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated" });
    expect(fake.audits).toHaveLength(0);
  });

  it.each([
    ["missing", null],
    ["unknown", UNKNOWN],
  ] as const)("%s credential: the nested payload is never traversed", async (_label, cred) => {
    noFetch();
    const fake = makeFakeAgentDb();
    const probe = countingFields();
    const a = await handleAgentEvent(fake.sql, cfg, probe.body, cred);
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ reason: "unauthenticated" });
    // The recursive digest enumerates and reads every nested value; grant
    // resolution needs only the credential, so the payload stays untouched.
    expect(probe.traversals()).toBe(0);
    expect(fake.audits).toHaveLength(0);
  });

  it.each([
    ["missing", null],
    ["unknown", UNKNOWN],
  ] as const)(
    "%s credential with a shallow valid body is 401 with zero audits",
    async (_l, cred) => {
      noFetch();
      const fake = makeFakeAgentDb();
      const a = await handleAgentEvent(
        fake.sql,
        cfg,
        { op: "create", idempotency_key: key(), fields: FIELDS },
        cred,
      );
      expect(a.status).toBe(401);
      expect(a.body).toMatchObject({ reason: "unauthenticated" });
      expect(fake.audits).toHaveLength(0);
      expect(fake.hits).toHaveLength(1);
    },
  );

  it("a flood of distinct unknown credentials with deep bodies grows the audit table by zero", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    for (let i = 0; i < 10; i++) {
      const a = await handleAgentEvent(fake.sql, cfg, deepBody(), `cred-flood-${i}`);
      expect(a.status).toBe(401);
      expect(a.body).toMatchObject({ reason: "unauthenticated" });
    }
    expect(fake.audits).toHaveLength(0);
    // Every hit still spent its own shield bucket: admission unchanged.
    expect(fake.hits).toHaveLength(10);
  });

  it("an unknown credential with a malformed envelope writes no audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const a = await handleAgentEvent(fake.sql, cfg, { idempotency_key: key() }, UNKNOWN);
    // 401 (auth first) or 422 (envelope first) are both acceptable orders;
    // an audit write for an unauthenticated hit is not.
    expect([401, 422]).toContain(a.status);
    expect(["unauthenticated", "validation_failed"]).toContain(a.body.reason);
    expect(fake.audits).toHaveLength(0);
  });

  it("a grantless non-object body writes no audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const a = await handleAgentEvent(fake.sql, cfg, [1, 2, 3], UNKNOWN);
    expect([401, 422]).toContain(a.status);
    expect(fake.audits).toHaveLength(0);
  });

  it("a grantless hit on a disabled ingress writes no audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const a = await handleAgentEvent(
      fake.sql,
      { ...cfg, enabled: false },
      { op: "create", idempotency_key: key(), fields: FIELDS },
      null,
    );
    expect([401, 404]).toContain(a.status);
    expect(["unauthenticated", "ingress_disabled"]).toContain(a.body.reason);
    expect(fake.audits).toHaveLength(0);
  });

  it("a spent shield bucket still refuses first, and no grantless hit in the run audits", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    const tight = { ...cfg, routePerMinute: 2 };
    const ip = "127.0.0.41";
    const spend = () =>
      handleAgentEvent(fake.sql, tight, { op: "create", idempotency_key: key() }, null, ip);
    expect((await spend()).status).toBe(401);
    expect((await spend()).status).toBe(401);
    const refused = await handleAgentEvent(fake.sql, tight, deepBody(), null, ip);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ reason: "rate_limited" });
    expect(fake.audits).toHaveLength(0);
  });

  it("the audit row for a granted over-deep payload is attributed to the resolved grant", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const a = await handleAgentEvent(fake.sql, cfg, deepBody(), GRANTED);
    expect(a.status).toBe(422);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ grantId: GRANT_ID, reason: "payload_too_deep" });
  });
});

describe("authenticated controls: existing behavior preserved (pass before and after)", () => {
  it("a granted over-deep body keeps 422 payload_too_deep plus exactly one audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const a = await handleAgentEvent(fake.sql, cfg, deepBody(), GRANTED);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ reason: "payload_too_deep" });
    expect(a.body.request_id).toBeTruthy();
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ reason: "payload_too_deep" });
  });

  it("a granted shallow create reaches 201", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: key(), fields: FIELDS },
      GRANTED,
    );
    expect(a.status).toBe(201);
    expect(a.body).not.toHaveProperty("replayed");
  });

  it("the traversal probe registers when a granted payload is digested", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const probe = countingFields();
    const a = await handleAgentEvent(fake.sql, cfg, probe.body, GRANTED);
    expect(a.status).toBe(201);
    // Positive control for the grantless zero-traversal pins: the digest
    // really does enumerate this exact payload shape when it runs.
    expect(probe.traversals()).toBeGreaterThan(0);
  });

  it("a granted replay answers from the store unchanged", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    const first = await handleAgentEvent(fake.sql, cfg, body, GRANTED);
    expect(first.status).toBe(201);
    const second = await handleAgentEvent(fake.sql, cfg, body, GRANTED);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ replayed: true });
  });

  it("a granted unknown op keeps 403 plus its audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "delete", idempotency_key: key() },
      GRANTED,
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "forbidden_action" });
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ grantId: GRANT_ID, reason: "forbidden_action" });
  });

  it("a granted malformed envelope keeps 422 plus its audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant());
    const a = await handleAgentEvent(fake.sql, cfg, { idempotency_key: key() }, GRANTED);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ reason: "validation_failed" });
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ reason: "validation_failed" });
  });

  it("an expired grant keeps 403 grant_expired plus its audit row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(GRANTED, liveGrant({ expires_at: new Date(Date.now() - 1000) }));
    const a = await handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: key(), fields: FIELDS },
      GRANTED,
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ reason: "grant_expired" });
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ grantId: GRANT_ID, reason: "grant_expired" });
  });
});
