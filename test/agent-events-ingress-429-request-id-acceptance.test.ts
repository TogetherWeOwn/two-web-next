// route-inventory: POST /api/agent-events
// Acceptance contract: every agent-events ingress 429 body carries the
// admission's `request_id`.
//
// Every sibling refusal already correlates: the 401 deny body is exactly
// `{message, reason, request_id}` and the 503 busy envelope carries the same
// admission ID its audit row records. The 429 throttle envelope is the one
// blind spot: it answers `{message, reason, retry_after}` with no ID, so an
// operator holding a throttled caller's response cannot tie it to the
// admission that refused it.
//
// The contract pinned here, at the service boundary and once through the
// mounted route:
// - A spent SHIELD bucket (anonymous and credentialed alike) answers 429
//   with a non-empty `request_id` beside reason/message/retry_after, and the
//   `Retry-After` header still mirrors `retry_after`.
// - A spent INNER bucket (per-grant and whole-service alike) answers the
//   same enriched envelope.
// - Each refused admission carries its OWN ID: two consecutive 429s differ,
//   and neither reuses an admitted neighbour's ID (no constant placeholder).
// - Nothing else changes: the message wording, the key set beyond the new
//   field, the absence of exception/trace/stack material, and the
//   charges-no-hit refusals. The refused hit writes no hit row but audits one
//   denied/rate_limited row with the admission request_id (see shield.ts for
//   the bucket-class encoding).
// - No credential material ever appears in the envelope.
//
// Hermetic and DB-free: the in-memory fake agent-event store records every
// hit and audit row, so spent buckets, audit deltas and the serialized route
// JSON are observed directly with no DATABASE_URL, network, or Discord.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import type { Env } from "../src/env";
import app from "./app";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-429-request-id-001";
const GRANT_ID = "grant-429-request-id-1";

const cfg = (routePerMinute: number): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
  routePerMinute,
});

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled 429 correlation proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

let n = 0;
const key = () => `ingress-429-request-id-${++n}`;

/** The full 429 key set once the admission ID rides the envelope. */
const KEYS_429 = ["message", "reason", "request_id", "retry_after"];

function expectCorrelated429(answer: { status: number; body: Record<string, unknown> }) {
  expect(answer.status).toBe(429);
  expect(Object.keys(answer.body).sort()).toEqual(KEYS_429);
  expect(typeof answer.body.request_id).toBe("string");
  expect((answer.body.request_id as string).length).toBeGreaterThan(0);
}

/** Spend an anonymous shield of 2 and return the refusal that follows. */
async function anonymousShieldRefusal(fake: FakeAgentDb) {
  const call = () =>
    handleAgentEvent(fake.sql, cfg(2), { op: "create", idempotency_key: key() }, null, "127.0.0.1");
  expect((await call()).status).toBe(401);
  expect((await call()).status).toBe(401);
  return call();
}

/** Spend one credential's shield of 2 (unknown grant) and return the refusal. */
async function credentialShieldRefusal(fake: FakeAgentDb, credential: string) {
  const call = () =>
    handleAgentEvent(
      fake.sql,
      cfg(2),
      { op: "create", idempotency_key: key() },
      credential,
      "127.0.0.1",
    );
  expect((await call()).status).toBe(401);
  expect((await call()).status).toBe(401);
  return call();
}

/** Authenticate, prespend one inner bucket, and return the refusal. */
async function innerRefusal(bucket: string) {
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
    cfg(60),
    { op: "create", idempotency_key: key(), fields: FIELDS },
    CRED,
  );
  return { fake, answer };
}

describe("ingress 429s carry the admission request_id", () => {
  it("anonymous shield refusal carries its admission request_id", async () => {
    const fake = makeFakeAgentDb();
    expectCorrelated429(await anonymousShieldRefusal(fake));
  });

  it("credentialed shield refusal carries its admission request_id", async () => {
    const fake = makeFakeAgentDb();
    expectCorrelated429(await credentialShieldRefusal(fake, "shield-probe-credential"));
  });

  it.each([
    ["per-grant mutating bucket", `mutating:${GRANT_ID}`],
    ["whole-service mutating bucket", "service-mutating"],
  ])("inner refusal from a spent %s carries its admission request_id", async (_name, bucket) => {
    const { answer } = await innerRefusal(bucket);
    expectCorrelated429(answer);
  });

  it("each refused admission carries its own ID, never a neighbour's", async () => {
    const fake = makeFakeAgentDb();
    const call = () =>
      handleAgentEvent(
        fake.sql,
        cfg(2),
        { op: "create", idempotency_key: key() },
        null,
        "127.0.0.1",
      );
    const admitted = await call();
    expect(admitted.status).toBe(401);
    expect((await call()).status).toBe(401);

    const first = await call();
    const second = await call();
    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    for (const refused of [first, second]) {
      expect(typeof refused.body.request_id).toBe("string");
      expect((refused.body.request_id as string).length).toBeGreaterThan(0);
      expect(refused.body.request_id).not.toBe(admitted.body.request_id);
    }
    expect(second.body.request_id).not.toBe(first.body.request_id);
  });
});

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

describe("ingress 429 request_id at the mounted route", () => {
  it("serialized route JSON carries the admission request_id", async () => {
    const fake = makeFakeAgentDb();
    const env = {
      APP_URL: "https://next.example.test",
      AGENT_EVENTS_ENABLED: "true",
      AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
      AGENT_EVENTS_ROUTE_PER_MINUTE: "2",
      AGENT_EVENT_SQL: fake.sql,
    } as unknown as Env;
    const post = () =>
      app.request(
        "/api/agent-events",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
          body: JSON.stringify({ op: "create", idempotency_key: key() }),
        },
        env,
        executionCtx,
      );

    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(401);
    const refused = await post();
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(KEYS_429);
    expect(typeof body.request_id).toBe("string");
    expect((body.request_id as string).length).toBeGreaterThan(0);
    expect(refused.headers.get("Retry-After")).toBe(String(body.retry_after));
  });
});

describe("positive controls: the 429 contract otherwise unchanged", () => {
  it("shield 429 keeps reason, message, retry_after and the Retry-After header", async () => {
    const fake = makeFakeAgentDb();
    const refused = await anonymousShieldRefusal(fake);
    expect(refused.status).toBe(429);
    expect(refused.body.reason).toBe("rate_limited");
    expect(typeof refused.body.retry_after).toBe("number");
    expect(Number(refused.body.retry_after)).toBeGreaterThanOrEqual(1);
    expect(refused.body.message).toBe(
      `Too many requests. Try again in ${refused.body.retry_after} seconds.`,
    );
    expect(refused.headers?.["Retry-After"]).toBe(String(refused.body.retry_after));
    expect(refused.body).not.toHaveProperty("exception");
    expect(refused.body).not.toHaveProperty("trace");
    expect(refused.body).not.toHaveProperty("stack");
  });

  it("unauthenticated-shield 429 audits one denied row and charges no hit", async () => {
    const fake = makeFakeAgentDb();
    const refused = await anonymousShieldRefusal(fake);
    expect(refused.status).toBe(429);
    // The refused hit wrote no hit row but one denied/rate_limited audit row
    // with the admission request_id, beside the two admitted hits and their
    // `unauthenticated` audit rows.
    expect(fake.hits).toHaveLength(2);
    expect(fake.audits).toHaveLength(3);
    const [first, second, row] = fake.audits;
    expect(first!.reason).toBe("unauthenticated");
    expect(second!.reason).toBe("unauthenticated");
    expect(row).toMatchObject({
      grantId: null,
      operation: "shield:anonymous",
      reason: "rate_limited",
      result: "denied",
      requestId: refused.body.request_id,
    });
  });

  it("inner 429 keeps the shared shape and charges no inner hit", async () => {
    const bucket = `mutating:${GRANT_ID}`;
    const { fake, answer } = await innerRefusal(bucket);
    expect(answer.status).toBe(429);
    expect(answer.body.reason).toBe("rate_limited");
    expect(typeof answer.body.retry_after).toBe("number");
    expect(answer.headers?.["Retry-After"]).toBe(String(answer.body.retry_after));
    expect(answer.body).not.toHaveProperty("exception");
    expect(answer.body).not.toHaveProperty("trace");
    expect(answer.body).not.toHaveProperty("stack");
    // The prespend is the only inner charge: the refusal itself is free.
    expect(fake.hits.filter((hit) => hit.bucket === bucket)).toHaveLength(999);
    expect(fake.hits.filter((hit) => hit.bucket === "service-mutating")).toHaveLength(0);
  });

  it("admitted denials keep their exact correlated shape", async () => {
    const fake = makeFakeAgentDb();
    const denied = await handleAgentEvent(
      fake.sql,
      cfg(60),
      { op: "create", idempotency_key: key() },
      null,
      "127.0.0.1",
    );
    expect(denied.status).toBe(401);
    expect(Object.keys(denied.body).sort()).toEqual(["message", "reason", "request_id"]);
    expect(typeof denied.body.request_id).toBe("string");
  });

  it("no credential material appears in the 429 envelope", async () => {
    const credential = "shield-probe-credential-429";
    const fake = makeFakeAgentDb();
    const refused = await credentialShieldRefusal(fake, credential);
    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).not.toContain(credential);
    expect(JSON.stringify(refused.headers ?? {})).not.toContain(credential);
  });
});
