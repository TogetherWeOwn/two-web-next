/// <reference types="vite/client" />
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  throttleEnvelope,
  type IngressConfig,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import agentEvents from "../drizzle/0001_agent-events.sql?raw";

// W15: the outer route shield (two-web TOG-8402, `agent-events.route_per_minute`).
// Every hit per credential per minute, counted in Postgres BEFORE auth, the
// grant lookup and the audit write; refused hits write nothing. Ports the
// shield half of tests/Feature/AgentEvents/AgentEventIngressTest.php.
//
// Live against agent-testdb in a throwaway schema. Skipped when DATABASE_URL
// is unset (CI has no test-DB access). Never point this at anything but
// agent-testdb.

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const cfg = (routePerMinute: number): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 1500,
  routePerMinute,
});
const FIELDS = {
  title: "Agent proof event", game: "Helldivers 2", description: "One uniquely labelled staging proof.",
  starts_at: "2026-10-01 20:00", ends_at: "2026-10-01 22:00", timezone: "Europe/London", location: "Voice: General", capacity: 4,
};

describe("throttle envelope (pure, two-web TOG-6788)", () => {
  it("answers one 429 shape: reason, message, retry_after, Retry-After, no stack", () => {
    const a = throttleEnvelope(42);
    expect(a.status).toBe(429);
    expect(a.body).toEqual({
      reason: "rate_limited",
      message: "Too many requests. Try again in 42 seconds.",
      retry_after: 42,
    });
    expect(a.headers).toEqual({ "Retry-After": "42" });
    expect(a.body).not.toHaveProperty("exception");
    expect(a.body).not.toHaveProperty("trace");
  });

  it("floors the wait at one second", () => {
    expect(throttleEnvelope(0).body.retry_after).toBe(1);
    expect(throttleEnvelope(0).headers).toEqual({ "Retry-After": "1" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("agent-events outer shield (agent-testdb)", () => {
  const schemaName = `w15_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let admin: postgres.Sql;
  let n = 0;
  const key = () => `shield-key-${++n}`;

  const call = (body: unknown, token: string | null, route: number, ip: string | null = "127.0.0.1") =>
    handleAgentEvent(sql, cfg(route), body, token, ip);

  async function grant(token: string, agent: string = CALLER, guild: string = STAGING) {
    await sql.unsafe(
      `INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash) VALUES ($1,'co',$2,$3)`,
      [agent, guild, await sha256Hex(token)],
    );
  }

  const audits = async (reason: string) =>
    (await sql`SELECT count(*)::int AS n FROM agent_event_audits WHERE reason_code = ${reason}`)[0]!.n as number;

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    sql = postgres(process.env.DATABASE_URL!, { max: 8, connection: { search_path: schemaName }, onnotice: () => {} });
    // drizzle qualifies FK targets with "public"; strip it so the throwaway schema owns them.
    for (const stmt of agentEvents.replaceAll('"public".', "").split("--> statement-breakpoint")) {
      if (stmt.trim()) await sql.unsafe(stmt);
    }
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  it("answers the bot's normal burst and refuses the ninth hit with the shared envelope", async () => {
    const token = `sh-burst-${schemaName}`;
    await grant(token);
    const req = (body: unknown, t: string | null = token) => call(body, t, 8);

    const created = await req({ op: "create", idempotency_key: key(), fields: FIELDS });
    expect(created.status).toBe(201);
    const eventKey = created.body.event_key as string;

    const updated = await req({
      op: "update", idempotency_key: key(), event_key: eventKey, version: 1,
      fields: { ...FIELDS, title: "Agent proof event, reconciled" },
    });
    expect(updated.status).toBe(200);

    // Three more distinct mutating attempts on the quota (all 409s, all
    // counted by both layers): five hits, still under the shield of 8.
    for (let i = 0; i < 3; i++) {
      expect((await req({ op: "create", idempotency_key: key(), fields: FIELDS })).status).toBe(409);
    }
    // Three more hits spend the shield of 8; the ninth is refused by the
    // outer layer — 429 JSON, never a stack.
    for (let i = 0; i < 3; i++) {
      await req({ op: "publish", idempotency_key: key(), event_key: eventKey });
    }
    const ninth = await req({ op: "create", idempotency_key: key(), fields: FIELDS });
    expect(ninth.status).toBe(429);
    expect(ninth.body.reason).toBe("rate_limited");
    expect(ninth.body.retry_after).toEqual(expect.any(Number));
    expect(ninth.headers?.["Retry-After"]).toBe(String(ninth.body.retry_after));
  });

  it("spends no shared bucket across credentials", async () => {
    const a = `sh-cred-a-${schemaName}`;
    const b = `sh-cred-b-${schemaName}`;
    await grant(a);
    await grant(b);
    // Each credential creates its one owned event at the default shield,
    // before the budget is tightened for the measured phase.
    const keyA = (
      await call({ op: "create", idempotency_key: key(), fields: FIELDS }, a, 60)
    ).body.event_key as string;
    const keyB = (
      await call({ op: "create", idempotency_key: key(), fields: FIELDS }, b, 60)
    ).body.event_key as string;
    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    // Cache::flush() equivalent: the setup hits must not spend the measured budget.
    await sql`DELETE FROM agent_event_hits`;

    const readA = { op: "read", idempotency_key: key(), event_key: keyA };
    expect((await call(readA, a, 2)).status).toBe(200);
    expect((await call({ ...readA, idempotency_key: key() }, a, 2)).status).toBe(200);
    const throttled = await call({ ...readA, idempotency_key: key() }, a, 2);
    expect(throttled.status).toBe(429);
    expect(throttled.body.reason).toBe("rate_limited");

    // The second credential hashes to its own bucket: still answered while
    // the first is throttled.
    expect((await call({ op: "read", idempotency_key: key(), event_key: keyB }, b, 2)).status).toBe(200);
  });

  it("refuses an unauthenticated flood at the shield before the database runs", async () => {
    // Earlier tests in this file created grants; the flood starts grant-free
    // (cascades clear their events and idempotency rows; audits keep null).
    await sql`DELETE FROM agent_event_grants`;
    const flood = () => call({ op: "create", idempotency_key: key(), fields: FIELDS }, null, 2);
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(401);

    const third = await flood();
    expect(third.status).toBe(429);
    expect(third.body.reason).toBe("rate_limited");
    expect(third.headers?.["Retry-After"]).toBeTruthy();

    // No grant rows touched; only the two shield-passed hits wrote
    // `unauthenticated` audit rows. The refused hit wrote nothing.
    expect((await sql`SELECT count(*)::int AS n FROM agent_event_grants`)[0]!.n).toBe(0);
    expect(await audits("unauthenticated")).toBe(2);
  });

  it("throttles rapid invalid-grant probes without leaking grant-existence oracles", async () => {
    // The flood test above wrote `unauthenticated` rows in this shared schema;
    // this test counts its own delta.
    const unauthBefore = await audits("unauthenticated");
    const nearToken = `sh-near-${schemaName}`;
    const farToken = `sh-far-${schemaName}`;
    const validToken = `sh-valid-${schemaName}`;
    await grant(validToken);
    const nearMiss = () => call({ op: "create", idempotency_key: key(), fields: FIELDS }, nearToken, 3);
    const farMiss = () => call({ op: "create", idempotency_key: key(), fields: FIELDS }, farToken, 3);

    const near = await nearMiss();
    const far = await farMiss();
    expect(near.status).toBe(401);
    expect(far.status).toBe(401);
    // No existence oracle: same reason, same message, same body shape.
    expect(near.body.reason).toBe("unauthenticated");
    expect(far.body.reason).toBe("unauthenticated");
    expect(near.body.message).toBe(far.body.message);
    expect(Object.keys(near.body).sort()).toEqual(["message", "reason", "request_id"]);
    expect(Object.keys(far.body).sort()).toEqual(["message", "reason", "request_id"]);

    // Two more near-miss hits spend that credential's shield of 3; the fourth
    // and fifth are refused by the outer layer with the shared envelope.
    expect((await nearMiss()).status).toBe(401);
    expect((await nearMiss()).status).toBe(401);
    const fourth = await nearMiss();
    expect(fourth.status).toBe(429);
    expect(fourth.body.reason).toBe("rate_limited");
    expect(fourth.headers?.["Retry-After"]).toBeTruthy();
    expect((await nearMiss()).status).toBe(429);

    // A different wrong credential hashes to its own bucket: still 401 while
    // the probed one is throttled.
    const farAgain = await farMiss();
    expect(farAgain.status).toBe(401);
    expect(farAgain.body.reason).toBe("unauthenticated");

    // The valid caller is unaffected: its own bucket, its own budget.
    const valid = await call({ op: "create", idempotency_key: key(), fields: FIELDS }, validToken, 3);
    expect(valid.status).toBe(201);

    // Only the unthrottled misses wrote rows (3 near + 2 far).
    expect((await audits("unauthenticated")) - unauthBefore).toBe(5);
  });
});
