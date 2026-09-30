/// <reference types="vite/client" />
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { DEFAULT_CONFIG, type IngressConfig, digest, handleAgentEvent, validateFields } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import users from "../drizzle/0000_init-users.sql?raw";
import agentEvents from "../drizzle/0001_agent-events.sql?raw";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const cfg: IngressConfig = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 1500 };
const FIELDS = {
  title: "Agent proof event", game: "Helldivers 2", description: "One uniquely labelled staging proof.",
  starts_at: "2026-10-01 20:00", ends_at: "2026-10-01 22:00", timezone: "Europe/London", location: "Voice: General", capacity: 4,
};

describe("validateFields / digest (pure)", () => {
  it("accepts the documented example and rejects bad wall times and offsets", () => {
    expect(validateFields(FIELDS).ok).toBe(true);
    expect(validateFields({ ...FIELDS, starts_at: "2026-10-01T20:00:00+01:00" }).ok).toBe(false);
    expect(validateFields({ ...FIELDS, starts_at: "2026-02-30 20:00" }).ok).toBe(false);
    expect(validateFields({ ...FIELDS, ends_at: "2026-10-01 19:00" }).ok).toBe(false);
    expect(validateFields({ ...FIELDS, timezone: "Not/AZone" }).ok).toBe(false);
    expect(validateFields({ ...FIELDS, capacity: 0 }).ok).toBe(false);
  });
  it("ignores key order in the digest", async () => {
    expect(await digest({ a: 1, b: { c: 2, d: 3 } })).toBe(await digest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(await digest({ a: 1 })).not.toBe(await digest({ a: 2 }));
  });
});

describe("worker route without a store", () => {
  it("answers 404 ingress_disabled by default and never touches a database", async () => {
    const res = await app.request("/api/agent-events", { method: "POST", body: "{}" }, {} as never);
    expect(res.status).toBe(404);
    expect((await res.json()) as { reason: string }).toMatchObject({ reason: "ingress_disabled" });
  });
  it("answers 503 when enabled but no store is bound", async () => {
    const res = await app.request("/api/agent-events", { method: "POST", body: "{}" }, { AGENT_EVENTS_ENABLED: "true" } as never);
    expect(res.status).toBe(503);
  });
});

// Live against agent-testdb, in a throwaway schema. Skipped when DATABASE_URL is unset (CI has
// no test-DB access). Never point this at anything but agent-testdb.
describe.skipIf(!process.env.DATABASE_URL)("agent-events ingress (agent-testdb)", () => {
  const schemaName = `w14_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let admin: postgres.Sql;
  const tokens = { good: "tok-good-" + schemaName, other: "tok-other-" + schemaName, prod: "tok-prod-" + schemaName, expired: "tok-exp-" + schemaName, disabled: "tok-dis-" + schemaName };

  const call = (body: unknown, token: string | null = tokens.good, c = cfg) => handleAgentEvent(sql, c, body, token);
  let n = 0;
  const key = () => `key-${++n}`;

  async function grant(token: string, agent: string, guild: string, extra = "") {
    await sql.unsafe(`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash ${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1,'co',$2,$3 ${extra ? ", " + extra.split("=")[1] : ""})`, [agent, guild, await sha256Hex(token)]);
  }

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    sql = postgres(process.env.DATABASE_URL!, { max: 8, connection: { search_path: schemaName }, onnotice: () => {} });
    // drizzle qualifies FK targets with "public"; strip it so the throwaway schema owns them.
    for (const stmt of `${users}\n--> statement-breakpoint\n${agentEvents}`.replaceAll('"public".', "").split("--> statement-breakpoint")) {
      if (stmt.trim()) await sql.unsafe(stmt);
    }
    await grant(tokens.good, CALLER, STAGING);
    await grant(tokens.other, "someone-else", STAGING);
    await grant(tokens.prod, CALLER, DEFAULT_CONFIG.productionGuildId);
    await grant(tokens.expired, CALLER, STAGING, "expires_at=now() - interval '1 hour'");
    await grant(tokens.disabled, CALLER, STAGING, "disabled_at=now()");
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  const audits = async (reason: string) => (await sql`SELECT count(*)::int AS n FROM agent_event_audits WHERE reason_code = ${reason}`)[0]!.n as number;

  it("denies before any work, with an audit row and no secret in it", async () => {
    expect((await call({ op: "create", idempotency_key: key() }, null)).body.reason).toBe("unauthenticated");
    expect((await call({ op: "create", idempotency_key: key() }, "nope")).status).toBe(401);
    expect((await call({ op: "explode", idempotency_key: key() })).body.reason).toBe("forbidden_action");
    expect((await call({ op: "create" })).status).toBe(422);
    expect((await call({ op: "create", idempotency_key: key() }, tokens.other)).body.reason).toBe("wrong_caller");
    expect((await call({ op: "create", idempotency_key: key() }, tokens.prod)).body.reason).toBe("production_guild");
    expect((await call({ op: "create", idempotency_key: key() }, tokens.expired)).body.reason).toBe("grant_expired");
    expect((await call({ op: "create", idempotency_key: key() }, tokens.disabled)).body.reason).toBe("grant_disabled");
    expect((await call({ op: "create", idempotency_key: key(), guild_id: DEFAULT_CONFIG.productionGuildId })).body.reason).toBe("wrong_guild");
    expect((await call({ op: "create", idempotency_key: key() }, tokens.good, { ...cfg, callerAgentId: "" })).body.reason).toBe("wrong_caller");
    expect((await call({ op: "create", idempotency_key: key() }, tokens.good, { ...cfg, enabled: false })).status).toBe(404);
    expect(await audits("unauthenticated")).toBeGreaterThanOrEqual(2);
    const dump = JSON.stringify(await sql`SELECT * FROM agent_event_audits`);
    for (const t of Object.values(tokens)) expect(dump).not.toContain(t);
    expect((await sql`SELECT count(*)::int AS n FROM agent_events`)[0]!.n).toBe(0);
  });

  it("creates once, replays the original response for a duplicate delivery, and conflicts on a changed payload", async () => {
    const k = key();
    const req = { op: "create", idempotency_key: k, fields: FIELDS };
    const first = await call(req);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "draft", agent_version: 1 });

    // duplicate delivery, key order shuffled: same answer, replayed, one event
    const dup = await call({ fields: { ...FIELDS }, idempotency_key: k, op: "create" });
    expect(dup.status).toBe(201);
    expect(dup.body).toMatchObject({ event_key: first.body.event_key, proof_marker: first.body.proof_marker, replayed: true });
    expect(dup.body.request_id).not.toBe(first.body.request_id);
    expect((await sql`SELECT count(*)::int AS n FROM agent_events`)[0]!.n).toBe(1);

    const conflict = await call({ ...req, fields: { ...FIELDS, title: "Different" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.reason).toBe("idempotency_conflict");

    const second = await call({ op: "create", idempotency_key: key(), fields: FIELDS });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ reason: "quota_exceeded", event_key: first.body.event_key });
  });

  it("does not store denials, so a fixed payload under the same key executes", async () => {
    const k = key();
    const [{ event_key }] = (await sql`SELECT event_key FROM agent_events`) as [{ event_key: string }];
    const bad = await call({ op: "update", idempotency_key: k, event_key, fields: FIELDS });
    expect(bad.status).toBe(422);
    const fixed = await call({ op: "update", idempotency_key: k, event_key, version: 1, fields: { ...FIELDS, title: "v2" } });
    expect(fixed.status).toBe(200);
    expect(fixed.body.agent_version).toBe(2);
  });

  it("read reports state and receipts, update enforces the version, lifecycle stays terminal", async () => {
    const read = await call({ op: "read", idempotency_key: key() });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ owned_event_count: 1, local: { status: "draft" }, discord: { unavailable: "verification_unavailable" } });
    expect((read.body.event as Record<string, unknown>).title).toBe("v2");
    expect((read.body.receipts as unknown[]).length).toBeGreaterThan(0);

    const stale = await call({ op: "update", idempotency_key: key(), version: 1, fields: FIELDS });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });

    expect((await call({ op: "publish", idempotency_key: key() })).body.status).toBe("published");
    expect((await call({ op: "publish", idempotency_key: key() })).body.reason).toBe("event_not_open");
    expect((await call({ op: "cancel", idempotency_key: key() })).body.status).toBe("cancelled");
    expect((await call({ op: "publish", idempotency_key: key() })).body.reason).toBe("event_not_open");
    expect((await call({ op: "update", idempotency_key: key(), version: 2, fields: FIELDS })).body.reason).toBe("event_not_open");

    expect((await call({ op: "read", idempotency_key: key(), event_key: "01NOSUCHEVENT000000000000" })).body.reason).toBe("event_not_found");
  });

  it("returns the latest receipts in chronological order, bounded at fifty", async () => {
    // Ports AgentEventReceiptWindowTest (boundary pair: exactly 50, latest 50
    // of 55). The read snapshots its own audit row after, so the window must
    // cut the oldest, not the newest.
    const t = "tok-window-" + schemaName;
    await grant(t, CALLER, STAGING);
    const withTok = (body: unknown) => handleAgentEvent(sql, cfg, body, t);
    const k = key();
    const created = await withTok({ op: "create", idempotency_key: k, fields: FIELDS });
    expect(created.status).toBe(201);
    const ek = created.body.event_key as string;
    const base = Date.now();
    for (let i = 0; i < 55; i++) {
      const id = `01WINDOW${String(i).padStart(4, "0")}000000000000`;
      const at = new Date(base + i * 1000).toISOString();
      await sql`INSERT INTO agent_event_audits (grant_id, event_key, operation, request_id, result, created_at)
                VALUES ((SELECT id FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(t)}), ${ek}, 'update', ${id}, 'ok', ${at})`;
    }
    // Newer foreign rows must not occupy the bounded window. Each matches
    // only one of the two scope filters, so neither filter can be dropped.
    const foreign = "tok-window-foreign-" + schemaName;
    await grant(foreign, CALLER, STAGING);
    await sql`INSERT INTO agent_event_audits (grant_id, event_key, operation, request_id, result, reason_code)
              VALUES ((SELECT id FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(foreign)}), ${ek}, 'cancel', 'foreign-grant-row', 'denied', 'foreign_event')`;
    await sql`INSERT INTO agent_event_audits (grant_id, event_key, operation, request_id, result, reason_code)
              VALUES ((SELECT id FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(t)}), '01FOREIGNEVENT000000000000', 'cancel', 'foreign-event-row', 'denied', 'foreign_event')`;
    const read = await withTok({ op: "read", idempotency_key: key(), event_key: ek });
    expect(read.status).toBe(200);
    const receipts = read.body.receipts as { request_id: string; at: string }[];
    expect(receipts).toHaveLength(50);
    // Latest 50 of 56 (55 seeded + the create): the create and the five
    // oldest seeded rows fell off, order is chronological.
    expect(receipts[0]!.request_id).toBe("01WINDOW0005000000000000");
    expect(receipts[49]!.request_id).toBe("01WINDOW0054000000000000");
    expect([...receipts].map((r) => r.at)).toEqual([...receipts].map((r) => r.at).sort());
  });

  it("concurrent duplicate deliveries execute once and every caller gets the one answer", async () => {
    // fresh grant so create quota is unspent
    const t = "tok-race-" + schemaName;
    await grant(t, CALLER, STAGING);
    const k = key();
    const req = { op: "create", idempotency_key: k, fields: FIELDS };
    const results = await Promise.all(Array.from({ length: 6 }, () => handleAgentEvent(sql, cfg, req, t)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_key)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed !== true)).toHaveLength(1);
    const [g] = await sql`SELECT id FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(t)}`;
    expect((await sql`SELECT count(*)::int AS n FROM agent_events WHERE agent_grant_id = ${g!.id}`)[0]!.n).toBe(1);
  });

  it("rate-limits mutating calls per grant, but replays are free", async () => {
    const t = "tok-rate-" + schemaName;
    await grant(t, CALLER, STAGING);
    const small = { ...cfg, mutatingPerMinute: 3 };
    const first = await handleAgentEvent(sql, small, { op: "create", idempotency_key: "rk", fields: FIELDS }, t);
    expect(first.status).toBe(201);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await handleAgentEvent(sql, small, { op: "publish", idempotency_key: `rp${i}` }, t)).status);
    expect(statuses).toEqual([200, 409, 429]);
    const limited = await handleAgentEvent(sql, small, { op: "publish", idempotency_key: "rp-x" }, t);
    expect(limited.headers?.["Retry-After"]).toBeTruthy();
    // a replay of the original create spends nothing and is still answered while limited
    const replay = await handleAgentEvent(sql, small, { op: "create", idempotency_key: "rk", fields: FIELDS }, t);
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
  });

  it("does not leak another grant's event", async () => {
    const [{ event_key }] = (await sql`SELECT e.event_key FROM agent_events e JOIN agent_event_grants g ON g.id = e.agent_grant_id WHERE g.verifier_hash = ${await sha256Hex(tokens.good)}`) as [{ event_key: string }];
    const t = "tok-foreign-" + schemaName;
    await grant(t, CALLER, STAGING);
    const r = await handleAgentEvent(sql, cfg, { op: "cancel", idempotency_key: "fx", event_key }, t);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("foreign_event");
  });
});
