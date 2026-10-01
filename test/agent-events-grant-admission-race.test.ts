import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, digest, handleAgentEvent, type Answer } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

const CALLER = "grant-admission-fixture";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 10000,
  serviceMutatingPerMinute: 1000, serviceReadsPerMinute: 1000 };
const fields = { title: "Synthetic admission proof", starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00", timezone: "UTC", location: "Fixture", capacity: 2 };

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe.skipIf(!process.env.DATABASE_URL)("grant admission after real SQL lock waits (isolated agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sql: postgres.Sql;
  let locker: postgres.Sql;
  let control: postgres.Sql;
  let eventTable: "agent_events" | "events";
  const appName = `grant-race-${randomUUID()}`;
  const writeBack = vi.fn(async () => {});
  const readEvent = vi.fn(async () => ({ ok: false as const, reason: "fixture" }));

  beforeAll(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!); // Refuse before any connection/DDL.
    fixture = await createMemberDataFixture(url.href);
    const options = { max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {} };
    const connection = { search_path: fixture.schemaName };
    sql = postgres(url.href, { ...options, connection: { ...connection, application_name: appName } });
    locker = postgres(url.href, { ...options, connection });
    control = postgres(url.href, { ...options, connection });
    const [tables] = await control`SELECT to_regclass('agent_events') AS standalone`;
    eventTable = tables!.standalone ? "agent_events" : "events";
  });
  afterAll(async () => {
    await sql?.end();
    await locker?.end();
    await control?.end();
    await fixture?.dispose();
  });

  async function caller() {
    const credential = `synthetic-admission-${randomUUID()}`;
    const verifier = await sha256Hex(credential);
    const [g] = await control`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'fixture-company', ${cfg.stagingGuildId}, ${verifier}) RETURNING id`;
    const grantId = g!.id as string;
    // Main has no effects argument. PR #124 uses these hermetic seams; no live bot/queue binding.
    const call = (body: unknown): Promise<Answer> => Reflect.apply(handleAgentEvent, undefined,
      [sql, cfg, body, credential, null, { writeBack, readEvent }]);
    const events = () => control.unsafe(`SELECT * FROM ${eventTable} WHERE agent_grant_id = $1`, [grantId]);
    const disable = () => control`UPDATE agent_event_grants SET disabled_at = clock_timestamp() WHERE id = ${grantId}`;
    // Move expiry into the past only after observing the request blocked in PostgreSQL.
    const expire = () => control`UPDATE agent_event_grants SET expires_at = clock_timestamp() WHERE id = ${grantId}`;
    const receipts = (key: string) => control`SELECT * FROM agent_event_audits
      WHERE grant_id = ${grantId} AND idempotency_key = ${key} ORDER BY id`;
    const stored = (key: string) => control`SELECT * FROM agent_event_idempotency_keys
      WHERE grant_id = ${grantId} AND key = ${key}`;
    return { grantId, credential, verifier, call, events, disable, expire, receipts, stored };
  }
  type Caller = Awaited<ReturnType<typeof caller>>;

  async function waiting(c: Caller, body: Record<string, unknown>, boundary: "operation" | "event" | "grant", change: (tx: postgres.TransactionSql) => Promise<unknown>) {
    const locked = signal();
    const release = signal();
    let held!: postgres.TransactionSql;
    const holding = locker.begin(async (tx) => {
      held = tx;
      if (boundary === "operation") {
        const lockName = body.op === "create" || body.op === "read" ? `agent-event-grant:${c.grantId}`
          : `agent-event:${body.event_key ?? `owned:${c.grantId}`}`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
      } else if (boundary === "event") {
        await tx.unsafe(`SELECT * FROM ${eventTable} WHERE agent_grant_id = $1 FOR UPDATE`, [c.grantId]);
      } else {
        await tx`SELECT id FROM agent_event_grants WHERE id = ${c.grantId} FOR NO KEY UPDATE`;
      }
      locked.resolve();
      await release.promise;
    });
    // A failed lock acquisition must surface rather than hanging the test's ready barrier.
    await Promise.race([locked.promise, holding]);
    const pending = c.call(body);
    try {
      // Assert the actual SQL wait, not an arbitrary sleep or a mocked service result.
      await expect.poll(async () => {
        const [r] = await control`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = ${appName} AND wait_event_type = 'Lock'
          AND query LIKE ${boundary === "operation" ? "%pg_advisory_xact_lock%" : boundary === "event" ? "%FOR UPDATE%" : "%FOR SHARE%"}`;
        return r!.n;
      }, { timeout: 4000, interval: 10 }).toBe(1);
      await change(held);
    } finally {
      release.resolve();
      await holding;
      // Always drain the request, including when the wait assertion fails.
      await pending;
    }
    return pending;
  }

  async function refused(c: Caller, body: Record<string, unknown>, answer: Answer, reason: string, before: unknown) {
    const events = await c.events();
    const stored = await c.stored(body.idempotency_key as string);
    const receipts = await c.receipts(body.idempotency_key as string);
    expect(answer.status, `events=${events.length}; success replay rows=${stored.length}; receipts=${receipts.map((r) => r.result).join(",")}`).toBe(403);
    expect(answer.body).toMatchObject({ reason, request_id: expect.any(String) });
    expect(answer.body.replayed).toBeUndefined();
    expect(events).toEqual(before);
    expect(stored).toHaveLength(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ operation: body.op, result: "denied", reason_code: reason,
      request_id: answer.body.request_id, payload_digest: await digest(body) });
    const evidence = JSON.stringify({ answer, receipts });
    expect(evidence).not.toContain(c.credential);
    expect(evidence).not.toContain(c.verifier);
    expect(writeBack).not.toHaveBeenCalled();
    expect(readEvent).not.toHaveBeenCalled();
  }

  for (const boundary of ["operation", "event"] as const) {
    for (const reason of ["grant_disabled", "grant_expired"] as const) {
      for (const op of (boundary === "operation" ? ["create", "read", "update", "publish", "cancel"] : ["read", "update", "publish", "cancel"])) {
        it(`${reason} during the ${boundary} wait refuses ${op} without mutations, success replay or effects`, async () => {
          const c = await caller();
          if (op !== "create") {
            expect((await c.call({ op: "create", fields, idempotency_key: randomUUID() })).status).toBe(201);
            if (eventTable === "events") {
              // Enable the PR #124 observation seam so a misplaced admission check is visible.
              await control`UPDATE events SET discord_event_id = ${c.grantId} WHERE agent_grant_id = ${c.grantId}`;
              if (op === "update") expect((await c.call({ op: "publish", idempotency_key: randomUUID() })).status).toBe(200);
            }
          }
          const before = await c.events();
          writeBack.mockClear();
          readEvent.mockClear();
          const body = { op, idempotency_key: randomUUID(), fields: { ...fields, title: "Must not mutate" }, version: 1 };
          const answer = await waiting(c, body, boundary, reason === "grant_disabled" ? c.disable : c.expire);
          await refused(c, body, answer, reason, before);
        });
      }
      if (boundary === "event") it(`${reason} during the event wait also refuses an explicit event_key`, async () => {
        const c = await caller();
        const created = await c.call({ op: "create", fields, idempotency_key: randomUUID() });
        expect(created.status).toBe(201);
        const before = await c.events();
        const body = { op: "update", fields, version: 1, event_key: created.body.event_key,
          idempotency_key: randomUUID() };
        writeBack.mockClear();
        readEvent.mockClear();
        const answer = await waiting(c, body, "event", reason === "grant_disabled" ? c.disable : c.expire);
        await refused(c, body, answer, reason, before);
      });
    }
  }

  for (const reason of ["grant_disabled", "grant_expired"] as const) {
    it(`refreshes ${reason} after waiting for the final grant lock`, async () => {
      const c = await caller();
      const body = { op: "create", fields, idempotency_key: randomUUID() };
      writeBack.mockClear();
      readEvent.mockClear();
      const answer = await waiting(c, body, "grant", (tx) => reason === "grant_disabled"
        ? tx`UPDATE agent_event_grants SET disabled_at = clock_timestamp() WHERE id = ${c.grantId}`
        : tx`UPDATE agent_event_grants SET expires_at = clock_timestamp() WHERE id = ${c.grantId}`);
      await refused(c, body, answer, reason, []);
    });
  }

  for (const boundary of ["operation", "event"] as const) {
    for (const offset of [-1, 0, 1]) {
      it(`${boundary} wait samples expiry at the boundary (${offset}ms)`, async () => {
        const c = await caller();
        if (boundary === "event") {
          expect((await c.call({ op: "create", fields, idempotency_key: randomUUID() })).status).toBe(201);
        }
        const before = await c.events();
        const body = { op: boundary === "operation" ? "create" : "update", fields,
          version: 1, idempotency_key: randomUUID() };
        writeBack.mockClear();
        readEvent.mockClear();
        const expiry = Date.parse("2099-07-01T00:00:00.000Z");
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          const answer = await waiting(c, body, boundary, async () => {
            await control`UPDATE agent_event_grants SET expires_at = ${new Date(expiry).toISOString()} WHERE id = ${c.grantId}`;
            // Initial admission already ran while live; only the post-wait clock is pinned.
            clock = vi.spyOn(Date, "now").mockReturnValue(expiry + offset);
          });
          if (offset >= 0) await refused(c, body, answer, "grant_expired", before);
          else {
            expect(answer.status).toBe(boundary === "operation" ? 201 : 200);
            expect(await c.stored(body.idempotency_key)).toHaveLength(1);
            expect(await c.receipts(body.idempotency_key)).toMatchObject([{ result: "ok" }]);
          }
        } finally { clock?.mockRestore(); }
      });
    }
  }

  it("refuses a success receipt that appeared while a now-disabled grant waited for the operation lock", async () => {
    const c = await caller();
    const body = { op: "create", idempotency_key: randomUUID(), fields };
    writeBack.mockClear();
    readEvent.mockClear();
    const answer = await waiting(c, body, "operation", async () => {
      await control`INSERT INTO agent_event_idempotency_keys (grant_id, key, payload_digest, status, body)
        VALUES (${c.grantId}, ${body.idempotency_key}, ${await digest(body)}, 201, ${JSON.stringify({ status: "draft" })}::text::jsonb)`;
      await c.disable();
    });
    expect(answer.status).toBe(403);
    expect(answer.body.reason).toBe("grant_disabled");
    expect(answer.body.replayed).toBeUndefined();
    expect(await c.events()).toHaveLength(0);
    expect(await c.stored(body.idempotency_key)).toHaveLength(1); // Existing evidence is not rewritten.
    expect(await c.receipts(body.idempotency_key)).toMatchObject([{ result: "denied", reason_code: "grant_disabled" }]);
    expect(writeBack).not.toHaveBeenCalled();
    expect(readEvent).not.toHaveBeenCalled();
  });

  for (const reason of ["grant_disabled", "grant_expired"] as const) {
    it(`preserves the initial ${reason} denial even when a fast replay exists`, async () => {
      const c = await caller();
      const body = { op: "create", fields, idempotency_key: randomUUID() };
      expect((await c.call(body)).status).toBe(201);
      const stored = await c.stored(body.idempotency_key);
      const before = await c.events();
      const hits = await control`SELECT * FROM agent_event_hits WHERE bucket = ${`mutating:${c.grantId}`}`;
      await (reason === "grant_disabled" ? c.disable() : c.expire());
      writeBack.mockClear();
      readEvent.mockClear();
      const answer = await c.call(body);
      expect(answer.status).toBe(403);
      expect(answer.body.reason).toBe(reason);
      expect(answer.body.replayed).toBeUndefined();
      expect(await c.events()).toEqual(before);
      expect(await c.stored(body.idempotency_key)).toEqual(stored);
      expect(await control`SELECT * FROM agent_event_hits WHERE bucket = ${`mutating:${c.grantId}`}`).toEqual(hits);
      expect(await c.receipts(body.idempotency_key)).toMatchObject([{ result: "ok" }, { result: "denied", reason_code: reason }]);
      expect(writeBack).not.toHaveBeenCalled();
      expect(readEvent).not.toHaveBeenCalled();
    });
  }

  it("admits unchanged live grants after both waits and still answers fast replay without inner budget", async () => {
    const c = await caller();
    const create = { op: "create", fields, idempotency_key: randomUUID() };
    const first = await waiting(c, create, "operation", async () => {});
    expect(first.status).toBe(201);
    const update = { op: "update", fields: { ...fields, title: "Allowed" }, version: 1, idempotency_key: randomUUID() };
    expect((await waiting(c, update, "event", async () => {})).status).toBe(200);
    expect(await c.events()).toMatchObject([{ title: "Allowed", agent_version: 2 }]);
    const hits = await control`SELECT * FROM agent_event_hits WHERE bucket = ${`mutating:${c.grantId}`}`;
    const replay = await c.call(create);
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    expect(await control`SELECT * FROM agent_event_hits WHERE bucket = ${`mutating:${c.grantId}`}`).toEqual(hits);
  });
});
