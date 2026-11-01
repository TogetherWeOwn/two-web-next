/// <reference types="vite/client" />
// route-inventory: POST /api/agent-events
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import {
  DEFAULT_CONFIG,
  type Answer,
  type IngressConfig,
  digest,
  handleAgentEvent,
  validateFields,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 1500,
};
const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled staging proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
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
    expect(await digest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      await digest({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(await digest({ a: 1 })).not.toBe(await digest({ a: 2 }));
  });
});

describe("worker route without a store", () => {
  it("answers 404 ingress_disabled by default and never touches a database", async () => {
    const res = await app.request("/api/agent-events", { method: "POST", body: "{}" }, {
      APP_URL: "https://next.example.test",
    } as never);
    expect(res.status).toBe(404);
    expect((await res.json()) as { reason: string }).toMatchObject({ reason: "ingress_disabled" });
  });
  it("answers 503 when enabled but no store is bound", async () => {
    const res = await app.request("/api/agent-events", { method: "POST", body: "{}" }, {
      APP_URL: "https://next.example.test",
      AGENT_EVENTS_ENABLED: "true",
    } as never);
    expect(res.status).toBe(503);
  });
});

// Live against agent-testdb, in a throwaway schema. Skipped when DATABASE_URL is unset (CI has
// no test-DB access). Never point this at anything but agent-testdb.
describe.skipIf(!process.env.DATABASE_URL)("agent-events ingress (agent-testdb)", () => {
  const schemaName = `w14_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let fixture: MemberDataFixture;
  const tokens = {
    good: "tok-good-" + schemaName,
    other: "tok-other-" + schemaName,
    prod: "tok-prod-" + schemaName,
    expired: "tok-exp-" + schemaName,
    disabled: "tok-dis-" + schemaName,
  };

  const call = (body: unknown, token: string | null = tokens.good, c = cfg) =>
    handleAgentEvent(sql, c, body, token);
  let n = 0;
  const key = () => `key-${++n}`;

  async function grant(token: string, agent: string, guild: string, extra = "") {
    await sql.unsafe(
      `INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash ${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1,'co',$2,$3 ${extra ? ", " + extra.split("=")[1] : ""})`,
      [agent, guild, await sha256Hex(token)],
    );
  }

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 8 });
    sql = fixture.client;
    await grant(tokens.good, CALLER, STAGING);
    await grant(tokens.other, "someone-else", STAGING);
    await grant(tokens.prod, CALLER, DEFAULT_CONFIG.productionGuildId);
    await grant(tokens.expired, CALLER, STAGING, "expires_at=now() - interval '1 hour'");
    await grant(tokens.disabled, CALLER, STAGING, "disabled_at=now()");
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const audits = async (reason: string) =>
    (await sql`SELECT count(*)::int AS n FROM agent_event_audits WHERE reason_code = ${reason}`)[0]!
      .n as number;

  it("denies before any work, with an audit row and no secret in it", async () => {
    expect((await call({ op: "create", idempotency_key: key() }, null)).body.reason).toBe(
      "unauthenticated",
    );
    expect((await call({ op: "create", idempotency_key: key() }, "nope")).status).toBe(401);
    expect((await call({ op: "explode", idempotency_key: key() })).body.reason).toBe(
      "forbidden_action",
    );
    expect((await call({ op: "create" })).status).toBe(422);
    expect((await call({ op: "create", idempotency_key: key() }, tokens.other)).body.reason).toBe(
      "wrong_caller",
    );
    expect((await call({ op: "create", idempotency_key: key() }, tokens.prod)).body.reason).toBe(
      "production_guild",
    );
    expect((await call({ op: "create", idempotency_key: key() }, tokens.expired)).body.reason).toBe(
      "grant_expired",
    );
    expect(
      (await call({ op: "create", idempotency_key: key() }, tokens.disabled)).body.reason,
    ).toBe("grant_disabled");
    expect(
      (
        await call({
          op: "create",
          idempotency_key: key(),
          guild_id: DEFAULT_CONFIG.productionGuildId,
        })
      ).body.reason,
    ).toBe("wrong_guild");
    expect(
      (
        await call({ op: "create", idempotency_key: key() }, tokens.good, {
          ...cfg,
          callerAgentId: "",
        })
      ).body.reason,
    ).toBe("wrong_caller");
    expect(
      (
        await call({ op: "create", idempotency_key: key() }, tokens.good, {
          ...cfg,
          enabled: false,
        })
      ).status,
    ).toBe(404);
    // Pre-auth refusals write zero audit rows: the two grantless denials
    // above (null credential, unknown token) recorded nothing.
    expect(await audits("unauthenticated")).toBe(0);
    const dump = JSON.stringify(await sql`SELECT * FROM agent_event_audits`);
    for (const t of Object.values(tokens)) expect(dump).not.toContain(t);
    expect((await sql`SELECT count(*)::int AS n FROM events`)[0]!.n).toBe(0);
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
    expect(dup.body).toMatchObject({
      event_key: first.body.event_key,
      proof_marker: first.body.proof_marker,
      replayed: true,
    });
    expect(dup.body.request_id).not.toBe(first.body.request_id);
    expect((await sql`SELECT count(*)::int AS n FROM events`)[0]!.n).toBe(1);

    const conflict = await call({ ...req, fields: { ...FIELDS, title: "Different" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.reason).toBe("idempotency_conflict");

    const second = await call({ op: "create", idempotency_key: key(), fields: FIELDS });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      reason: "quota_exceeded",
      event_key: first.body.event_key,
    });
  });

  it("does not store denials, so a fixed payload under the same key executes", async () => {
    const k = key();
    const [{ event_key }] = (await sql`SELECT event_key FROM events`) as [{ event_key: string }];
    const bad = await call({ op: "update", idempotency_key: k, event_key, fields: FIELDS });
    expect(bad.status).toBe(422);
    const fixed = await call({
      op: "update",
      idempotency_key: k,
      event_key,
      version: 1,
      fields: { ...FIELDS, title: "v2" },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.agent_version).toBe(2);
  });

  it("read reports state and receipts, update enforces the version, lifecycle stays terminal", async () => {
    const read = await call({ op: "read", idempotency_key: key() });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      owned_event_count: 1,
      local: { status: "draft" },
      discord: { unavailable: "verification_unavailable" },
    });
    expect((read.body.event as Record<string, unknown>).title).toBe("v2");
    expect((read.body.receipts as unknown[]).length).toBeGreaterThan(0);

    const stale = await call({ op: "update", idempotency_key: key(), version: 1, fields: FIELDS });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });

    expect((await call({ op: "publish", idempotency_key: key() })).body.status).toBe("published");
    expect((await call({ op: "publish", idempotency_key: key() })).body.reason).toBe(
      "event_not_open",
    );
    expect((await call({ op: "cancel", idempotency_key: key() })).body.status).toBe("cancelled");
    expect((await call({ op: "publish", idempotency_key: key() })).body.reason).toBe(
      "event_not_open",
    );
    expect(
      (await call({ op: "update", idempotency_key: key(), version: 2, fields: FIELDS })).body
        .reason,
    ).toBe("event_not_open");

    expect(
      (await call({ op: "read", idempotency_key: key(), event_key: "01NOSUCHEVENT000000000000" }))
        .body.reason,
    ).toBe("event_not_found");
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
    const verifierHash = await sha256Hex(t);
    await sql`INSERT INTO agent_event_audits (grant_id, event_key, operation, request_id, result, created_at)
              SELECT (SELECT id FROM agent_event_grants WHERE verifier_hash = ${verifierHash}),
                     ${ek}, 'update', '01WINDOW' || lpad(i::text, 4, '0') || '000000000000',
                     'ok', ${new Date(base).toISOString()}::timestamptz + i * interval '1 second'
              FROM generate_series(0, 54) AS seed(i) ORDER BY i`;
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
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handleAgentEvent(sql, cfg, req, t)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_key)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed !== true)).toHaveLength(1);
    const [g] =
      await sql`SELECT id FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(t)}`;
    expect(
      (await sql`SELECT count(*)::int AS n FROM events WHERE agent_grant_id = ${g!.id}`)[0]!.n,
    ).toBe(1);
  });

  it("rate-limits mutating calls per grant, but replays are free", async () => {
    const t = "tok-rate-" + schemaName;
    await grant(t, CALLER, STAGING);
    const small = { ...cfg, mutatingPerMinute: 3 };
    const first = await handleAgentEvent(
      sql,
      small,
      { op: "create", idempotency_key: "rk", fields: FIELDS },
      t,
    );
    expect(first.status).toBe(201);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await handleAgentEvent(sql, small, { op: "publish", idempotency_key: `rp${i}` }, t))
          .status,
      );
    expect(statuses).toEqual([200, 409, 429]);
    const limited = await handleAgentEvent(
      sql,
      small,
      { op: "publish", idempotency_key: "rp-x" },
      t,
    );
    expect(limited.headers?.["Retry-After"]).toBeTruthy();
    // a replay of the original create spends nothing and is still answered while limited
    const replay = await handleAgentEvent(
      sql,
      small,
      { op: "create", idempotency_key: "rk", fields: FIELDS },
      t,
    );
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
  });

  it("does not leak another grant's event", async () => {
    const [{ event_key }] =
      (await sql`SELECT e.event_key FROM events e JOIN agent_event_grants g ON g.id = e.agent_grant_id WHERE g.verifier_hash = ${await sha256Hex(tokens.good)}`) as [
        { event_key: string },
      ];
    const t = "tok-foreign-" + schemaName;
    await grant(t, CALLER, STAGING);
    const r = await handleAgentEvent(
      sql,
      cfg,
      { op: "cancel", idempotency_key: "fx", event_key },
      t,
    );
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("foreign_event");
  });
  // Real PostgreSQL witnesses for receipt lock compatibility, post-write
  // rollback and the actual Drizzle pg-proxy cancellation wrapper. No
  // synthetic SQLSTATEs. These live under this file's existing DATABASE_URL
  // gate: the fixture-only offline lane never opens a connection, and an
  // absent DATABASE_URL never selects a built-in database.
  describe("statement deadlines through real ingress (Postgres)", () => {
    const sdCfg = {
      ...DEFAULT_CONFIG,
      enabled: true,
      callerAgentId: "statement-deadline-regression",
      lockWaitMs: 100,
    };
    const fields = {
      title: "Statement deadline fixture",
      game: "Chess",
      description: "Synthetic fixture only",
      starts_at: "2099-07-01 20:00",
      ends_at: "2099-07-01 22:00",
      timezone: "UTC",
      location: "Fixture",
      capacity: 2,
    };

    // Preserve native lazy queries, especially unsafe(...).values(). Only the
    // post-UPDATE Drizzle SELECT is replaced, by real server-side execution work.
    function observe(raw: postgres.Sql, slowUpdateRead = false) {
      const errors: unknown[] = [];
      let wroteEvent = false;
      let injected = false;
      function wrap(client: postgres.Sql): postgres.Sql {
        return new Proxy(client, {
          apply(target, _self, args) {
            const [strings] = args as [TemplateStringsArray];
            if (strings.join(" ").trim().toLowerCase().startsWith("update events set"))
              wroteEvent = true;
            return Reflect.apply(target, target, args);
          },
          get(target, key) {
            if (key === "begin")
              return async (fn: (tx: postgres.Sql) => Promise<unknown>) => {
                try {
                  return await target.begin((tx) => fn(wrap(tx as unknown as postgres.Sql)));
                } catch (error) {
                  errors.push(error);
                  throw error;
                }
              };
            if (key === "unsafe")
              return (query: string, params?: never[]) => {
                if (
                  slowUpdateRead &&
                  wroteEvent &&
                  !injected &&
                  query.toLowerCase().includes('from "events"')
                ) {
                  injected = true;
                  return target.unsafe("select pg_sleep(0.6)");
                }
                return target.unsafe(query, params);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return { sdSql: wrap(raw), errors, injected: () => injected };
    }

    function busy(answer: Answer) {
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({
        code: "operation_busy",
        reason: "operation_busy",
        next: "Retry with the same idempotency key.",
      });
      expect(answer.body.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(answer.headers ?? {}).not.toHaveProperty("Retry-After");
      expect(JSON.stringify(answer)).not.toMatch(/pg_sleep|57014|55P03|Drizzle|PostgresError/);
    }
    let sdFixture: JobsFixture;
    let sdSql: postgres.Sql;
    let holder: postgres.Sql;
    let grantId: string;
    let credential: string;
    let pid: number;
    const writeBack = vi.fn(async () => {});

    beforeEach(async () => {
      // Gated by the parent describe: DATABASE_URL is set here, and
      // testDatabaseUrl refuses anything but an approved disposable test DB.
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      sdFixture = await createJobsFixture(url.href);
      sdSql = sdFixture.client;
      pid = (await sdSql`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      holder = postgres(url.href, {
        max: 1,
        password: () => url.password,
        connect_timeout: 5,
        connection: { search_path: sdFixture.schemaName },
        onnotice: () => {},
      });
      credential = `synthetic-deadline-${randomUUID()}`;
      const verifier = await sha256Hex(credential);
      const [grant] = await sdSql`INSERT INTO agent_event_grants
        (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${sdCfg.callerAgentId}, 'fixture-company', ${sdCfg.stagingGuildId}, ${verifier}) RETURNING id`;
      grantId = grant!.id;
      writeBack.mockClear();
    });
    afterEach(async () => {
      await holder?.end({ timeout: 1 });
      await sdFixture?.dispose();
    });

    const sdCall = (client: postgres.Sql, body: unknown) =>
      handleAgentEvent(client, sdCfg, body, credential, null, { writeBack });
    const create = (key: string) => ({ op: "create", idempotency_key: key, fields });
    const receipt = (key: string) =>
      sdSql`SELECT * FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`;
    const sdAudits = (key: string) =>
      sdSql`SELECT * FROM agent_event_audits WHERE grant_id = ${grantId} AND idempotency_key = ${key} ORDER BY id`;

    async function expectReceipt(answer: Answer, key: string, operation: string) {
      const rows = await sdAudits(key);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        request_id: answer.body.request_id,
        operation,
        result: "error",
        reason_code: "operation_busy",
      });
      expect(await receipt(key)).toHaveLength(0);
      expect(writeBack).not.toHaveBeenCalled();
      const [settings] = await sdSql`SELECT pg_backend_pid() AS pid,
        current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
      expect(settings).toMatchObject({ pid, statement: "0", lock: "0" });
    }

    it("a held non-key grant disable does not block the busy receipt a second time", async () => {
      const key = "held-disable";
      const observed = observe(sdSql);
      await holder.unsafe("BEGIN");
      try {
        await holder`UPDATE agent_event_grants SET disabled_at = clock_timestamp() WHERE id = ${grantId}`;
        // Holder remains uncommitted across the operation timeout AND receipt.
        const answer = await sdCall(observed.sdSql, create(key));
        busy(answer);
        expect(observed.errors).toHaveLength(1);
        expect(["55P03", "57014"]).toContain((observed.errors[0] as { code: string }).code);
        await expectReceipt(answer, key, "create");
        expect(await sdSql`SELECT id FROM events WHERE agent_grant_id = ${grantId}`).toHaveLength(
          0,
        );
        const [held] =
          await holder`SELECT disabled_at IS NOT NULL AS disabled FROM agent_event_grants WHERE id = ${grantId}`;
        expect(held!.disabled).toBe(true);
      } finally {
        await holder.unsafe("ROLLBACK");
      }
      expect((await sdCall(sdSql, create(key))).status).toBe(201);
    });

    it("an executing receipt INSERT cancels after event and audit writes, rolls back, then retries", async () => {
      const key = "post-write-stall";
      await sdSql.unsafe(`CREATE FUNCTION stall_deadline_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$`);
      await sdSql.unsafe(`CREATE TRIGGER stall_deadline_receipt BEFORE INSERT ON agent_event_idempotency_keys
        FOR EACH ROW EXECUTE FUNCTION stall_deadline_receipt()`);
      const observed = observe(sdSql);
      const answer = await sdCall(observed.sdSql, create(key));
      busy(answer);
      expect(observed.errors).toHaveLength(1);
      expect(observed.errors[0]).toMatchObject({ code: "57014" });
      await expectReceipt(answer, key, "create");
      expect(await sdSql`SELECT id FROM events WHERE agent_grant_id = ${grantId}`).toHaveLength(0);
      await sdSql.unsafe("DROP TRIGGER stall_deadline_receipt ON agent_event_idempotency_keys");
      const retry = await sdCall(sdSql, create(key));
      expect(retry.status).toBe(201);
      expect(await receipt(key)).toHaveLength(1);
      expect(await sdSql`SELECT id FROM events WHERE agent_grant_id = ${grantId}`).toHaveLength(1);
      const replay = await sdCall(sdSql, create(key));
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ event_key: retry.body.event_key, replayed: true });
      expect((await sdAudits(key)).filter((a) => a.result === "ok")).toHaveLength(1);
    });

    it("actual Drizzle update cancellation after UPDATE rolls back and recovers with the same key", async () => {
      const seeded = await sdCall(sdSql, create("update-seed"));
      expect(seeded.status).toBe(201);
      const published = await sdCall(sdSql, {
        op: "publish",
        idempotency_key: "update-publish-seed",
        event_key: seeded.body.event_key,
      });
      expect(published.status).toBe(200);
      expect(writeBack).toHaveBeenCalledTimes(1);
      writeBack.mockClear();
      const key = "wrapped-update-stall";
      const body = {
        op: "update",
        idempotency_key: key,
        event_key: seeded.body.event_key,
        version: 1,
        fields: { ...fields, title: "Retried update" },
      };
      const observed = observe(sdSql, true);
      const answer = await sdCall(observed.sdSql, body);
      busy(answer);
      expect(observed.injected()).toBe(true);
      expect(observed.errors).toHaveLength(1);
      const error = observed.errors[0] as Error & { code?: string; cause: { code: string } };
      expect(error.constructor.name).toBe("DrizzleQueryError");
      expect(error.name).toBe("Error");
      expect(error.code).toBeUndefined();
      expect(error.cause.code).toBe("57014");
      await expectReceipt(answer, key, "update");
      const [unchanged] =
        await sdSql`SELECT title, agent_version FROM events WHERE agent_grant_id = ${grantId}`;
      expect(unchanged).toMatchObject({ title: fields.title, agent_version: 1 });
      const retry = await sdCall(sdSql, body);
      expect(retry.status).toBe(200);
      expect(retry.body.agent_version).toBe(2);
      expect(await receipt(key)).toHaveLength(1);
      expect(writeBack).toHaveBeenCalledTimes(1);
      const [updated] =
        await sdSql`SELECT title, agent_version FROM events WHERE agent_grant_id = ${grantId}`;
      expect(updated).toMatchObject({ title: "Retried update", agent_version: 2 });
      const replay = await sdCall(sdSql, body);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ event_key: seeded.body.event_key, replayed: true });
      expect(writeBack).toHaveBeenCalledTimes(1);
    });
  });
});
