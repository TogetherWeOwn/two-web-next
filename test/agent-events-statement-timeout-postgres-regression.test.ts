// Real PostgreSQL witnesses for receipt lock compatibility, post-write rollback
// and the actual Drizzle pg-proxy cancellation wrapper. No synthetic SQLSTATEs.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type Answer } from "../src/agent-events/service";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { sha256Hex } from "../src/bot/signer";

const cfg = {
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
  return { sql: wrap(raw), errors, injected: () => injected };
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

describe("statement deadlines through real ingress (Postgres)", () => {
  let fixture: JobsFixture;
  let sql: postgres.Sql;
  let holder: postgres.Sql;
  let grantId: string;
  let credential: string;
  let pid: number;
  const writeBack = vi.fn(async () => {});

  beforeEach(async () => {
    // Always execute these witnesses. The fallback is the established disposable
    // test service, never an inherited application binding or staging database.
    const url = testDatabaseUrl(
      process.env.DATABASE_URL ?? "postgres://agent_test@agent-testdb:5432/two_web_next",
    );
    fixture = await createJobsFixture(url.href);
    sql = fixture.client;
    pid = (await sql`SELECT pg_backend_pid() AS pid`)[0]!.pid;
    holder = postgres(url.href, {
      max: 1,
      password: () => url.password,
      connect_timeout: 5,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    credential = `synthetic-deadline-${randomUUID()}`;
    const verifier = await sha256Hex(credential);
    const [grant] = await sql`INSERT INTO agent_event_grants
      (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${cfg.callerAgentId}, 'fixture-company', ${cfg.stagingGuildId}, ${verifier}) RETURNING id`;
    grantId = grant!.id;
    writeBack.mockClear();
  });
  afterEach(async () => {
    await holder?.end({ timeout: 1 });
    await fixture?.dispose();
  });

  const call = (client: postgres.Sql, body: unknown) =>
    handleAgentEvent(client, cfg, body, credential, null, { writeBack });
  const create = (key: string) => ({ op: "create", idempotency_key: key, fields });
  const receipt = (key: string) =>
    sql`SELECT * FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`;
  const audits = (key: string) =>
    sql`SELECT * FROM agent_event_audits WHERE grant_id = ${grantId} AND idempotency_key = ${key} ORDER BY id`;

  async function expectReceipt(answer: Answer, key: string, operation: string) {
    const rows = await audits(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: answer.body.request_id,
      operation,
      result: "error",
      reason_code: "operation_busy",
    });
    expect(await receipt(key)).toHaveLength(0);
    expect(writeBack).not.toHaveBeenCalled();
    const [settings] = await sql`SELECT pg_backend_pid() AS pid,
      current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
    expect(settings).toMatchObject({ pid, statement: "0", lock: "0" });
  }

  it("a held non-key grant disable does not block the busy receipt a second time", async () => {
    const key = "held-disable";
    const observed = observe(sql);
    await holder.unsafe("BEGIN");
    try {
      await holder`UPDATE agent_event_grants SET disabled_at = clock_timestamp() WHERE id = ${grantId}`;
      // Holder remains uncommitted across the operation timeout AND receipt.
      const answer = await call(observed.sql, create(key));
      busy(answer);
      expect(observed.errors).toHaveLength(1);
      expect(["55P03", "57014"]).toContain((observed.errors[0] as { code: string }).code);
      await expectReceipt(answer, key, "create");
      expect(await sql`SELECT id FROM events WHERE agent_grant_id = ${grantId}`).toHaveLength(0);
      const [held] =
        await holder`SELECT disabled_at IS NOT NULL AS disabled FROM agent_event_grants WHERE id = ${grantId}`;
      expect(held!.disabled).toBe(true);
    } finally {
      await holder.unsafe("ROLLBACK");
    }
    expect((await call(sql, create(key))).status).toBe(201);
  });

  it("an executing receipt INSERT cancels after event and audit writes, rolls back, then retries", async () => {
    const key = "post-write-stall";
    await sql.unsafe(`CREATE FUNCTION stall_deadline_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER stall_deadline_receipt BEFORE INSERT ON agent_event_idempotency_keys
      FOR EACH ROW EXECUTE FUNCTION stall_deadline_receipt()`);
    const observed = observe(sql);
    const answer = await call(observed.sql, create(key));
    busy(answer);
    expect(observed.errors).toHaveLength(1);
    expect(observed.errors[0]).toMatchObject({ code: "57014" });
    await expectReceipt(answer, key, "create");
    expect(await sql`SELECT id FROM events WHERE agent_grant_id = ${grantId}`).toHaveLength(0);
    await sql.unsafe("DROP TRIGGER stall_deadline_receipt ON agent_event_idempotency_keys");
    const retry = await call(sql, create(key));
    expect(retry.status).toBe(201);
    expect(await receipt(key)).toHaveLength(1);
    expect(await sql`SELECT id FROM events WHERE agent_grant_id = ${grantId}`).toHaveLength(1);
    const replay = await call(sql, create(key));
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ event_key: retry.body.event_key, replayed: true });
    expect((await audits(key)).filter((a) => a.result === "ok")).toHaveLength(1);
  });

  it("actual Drizzle update cancellation after UPDATE rolls back and recovers with the same key", async () => {
    const seeded = await call(sql, create("update-seed"));
    expect(seeded.status).toBe(201);
    const published = await call(sql, {
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
    const observed = observe(sql, true);
    const answer = await call(observed.sql, body);
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
      await sql`SELECT title, agent_version FROM events WHERE agent_grant_id = ${grantId}`;
    expect(unchanged).toMatchObject({ title: fields.title, agent_version: 1 });
    const retry = await call(sql, body);
    expect(retry.status).toBe(200);
    expect(retry.body.agent_version).toBe(2);
    expect(await receipt(key)).toHaveLength(1);
    expect(writeBack).toHaveBeenCalledTimes(1);
    const [updated] =
      await sql`SELECT title, agent_version FROM events WHERE agent_grant_id = ${grantId}`;
    expect(updated).toMatchObject({ title: "Retried update", agent_version: 2 });
    const replay = await call(sql, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ event_key: seeded.body.event_key, replayed: true });
    expect(writeBack).toHaveBeenCalledTimes(1);
  });
});
