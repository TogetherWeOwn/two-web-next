/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Acceptance: the INNER rate-budget admission (the per-grant and per-service
// advisory locks taken before the operation runs) must bound its lock wait
// with the configured busy timeout, exactly like the outer shield already
// does. While another connection holds the exact inner service or grant
// advisory lock and `lockWaitMs` is 50, an otherwise valid request must
// settle — while the holder remains locked — as a retryable 503
// `operation_busy`, audited `error`/`operation_busy` (never
// `denied`/`rate_limited`), inserting no inner budget hits, no event
// mutation and no idempotency receipt. After the lock is released, normal
// admission succeeds. True 429 envelopes, free replays and grant checks are
// unchanged.
//
// The configured lockWaitMs magnitude is pinned without reading the
// JavaScript clock: every busy case holds its lock on a database-side
// self-release schedule (pg_sleep(1) inside the holder transaction, then
// ROLLBACK) while lockWaitMs stays 50. A wait honoring the configured 50ms
// answers 503 long before the 1s release; a wait ignoring it (say the 5s
// default) would still be blocked at 1s, see the release, and be admitted
// (200/201) instead of refused, failing the status assert.
//
// Lock acquisition is coordinated explicitly: the holder's advisory-lock
// query resolving inside its open transaction is the handshake that the
// lock is held. The holder then sleeps on the database clock and releases
// itself; the measured call is awaited directly with no JavaScript timer —
// arrival of the 503 verdict before that self-release IS the proof the
// configured lockWaitMs database lock_timeout fired. An unbounded wait hangs
// past the vitest test timeout instead. No wall-clock race, no fake timers,
// no timing-only sleep proves anything here.
//
// Live against the guarded test database in a throwaway schema. Skipped
// when DATABASE_URL is unset. Never point this at production or staging.

const CALLER = "inner-lock-busy-fixture";

const cfg = (overrides: Partial<IngressConfig> = {}): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 1500,
  ...overrides,
});

const FIELDS = {
  title: "Inner lock busy proof",
  game: "Chess",
  description: "Synthetic fixture event, never live.",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Fixture",
  capacity: 2,
};

describe("inner-lock busy test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "inner rate-budget lock waits are busy-bounded (test database)",
  () => {
    let fixture: MemberDataFixture;
    let sql: postgres.Sql;
    let eventTable: "agent_events" | "events";

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 8 });
      sql = fixture.client;
      const [tables] = await sql`SELECT to_regclass('agent_events') AS standalone`;
      eventTable = tables!.standalone ? "agent_events" : "events";
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    async function caller() {
      const credential = `synthetic-inner-lock-${randomUUID()}`;
      const verifier = await sha256Hex(credential);
      const [grant] =
        await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${CALLER}, 'fixture-company', ${DEFAULT_CONFIG.stagingGuildId}, ${verifier}) RETURNING id`;
      const grantId = grant!.id as string;
      const call = (body: unknown, config: IngressConfig = cfg()): Promise<Answer> =>
        handleAgentEvent(sql, config, body, credential, null);
      // Inner budget hits only: the outer shield bucket is a separate layer
      // and may legitimately record the attempt before the inner refusal.
      const innerHits = async () => {
        const rows = await sql`SELECT bucket, count(*)::int AS n FROM agent_event_hits
          WHERE bucket IN (${`read:${grantId}`}, ${`mutating:${grantId}`}, 'service-read', 'service-mutating')
          GROUP BY bucket ORDER BY bucket`;
        return rows.map((r) => ({ bucket: r.bucket as string, n: r.n as number }));
      };
      const auditsFor = (key: string) =>
        sql`SELECT * FROM agent_event_audits WHERE idempotency_key = ${key} ORDER BY id`;
      const stored = (key: string) =>
        sql`SELECT * FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`;
      const events = () =>
        sql.unsafe(`SELECT * FROM ${eventTable} WHERE agent_grant_id = $1 ORDER BY 1`, [grantId]);
      const secretFree = async () => {
        const dump = JSON.stringify(await sql`SELECT * FROM agent_event_audits`);
        expect(dump).not.toContain(credential);
        expect(dump).not.toContain(verifier);
      };
      return { call, innerHits, auditsFor, stored, events, secretFree, grantId };
    }

    // Hold `agent-event-hits:<bucket>` on a database-side self-release
    // schedule. The await resolves only once the lock is actually held; the
    // returned `done` promise resolves once the holder has slept `delaySecs`
    // on the database clock (inside its open transaction, so the lock stays
    // held throughout) and rolled back. The handle is a plain object (not a
    // nested promise) because await flattens Promise<Promise<T>> and would
    // wait out the whole self-release instead of just the handshake. A
    // measured wait honoring the configured 50ms answers 503 before that
    // release; a wait ignoring it is still blocked at release time, sees the
    // lock free, and is admitted instead.
    async function holdBucketLockDbDelayed(
      bucket: string,
      delaySecs: number,
    ): Promise<{ done: Promise<void> }> {
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      const holder = postgres(url.href, {
        max: 1,
        port: 5432,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      await holder.unsafe("BEGIN");
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${"agent-event-hits:" + bucket}, 0))`;
      const done = (async () => {
        try {
          await holder.unsafe(`SELECT pg_sleep(${delaySecs})`);
        } finally {
          try {
            await holder.unsafe("ROLLBACK");
          } catch {
            // Already closed; the lock is gone either way.
          }
          await holder.end().catch(() => {});
        }
      })();
      return { done };
    }

    it("control: admits a valid create and read, charges one hit per inner bucket, leaks no secret", async () => {
      const c = await caller();
      const created = await c.call({ op: "create", idempotency_key: randomUUID(), fields: FIELDS });
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty("exception");
      expect(created.body).not.toHaveProperty("trace");
      const eventKey = created.body.event_key as string;
      expect(eventKey).toBeTruthy();

      const read = await c.call({ op: "read", idempotency_key: randomUUID(), event_key: eventKey });
      expect(read.status).toBe(200);

      expect(await c.innerHits()).toEqual([
        { bucket: `mutating:${c.grantId}`, n: 1 },
        { bucket: `read:${c.grantId}`, n: 1 },
        { bucket: "service-mutating", n: 1 },
        { bucket: "service-read", n: 1 },
      ]);
      await c.secretFree();
    });

    it("control: a free replay answers from the receipt and charges no inner budget", async () => {
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields: FIELDS };
      const first = await c.call(body);
      expect(first.status).toBe(201);
      const hitsAfterFirst = await c.innerHits();

      const replay = await c.call({ fields: { ...FIELDS }, idempotency_key: key, op: "create" });
      expect(replay.status).toBe(201);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.event_key).toBe(first.body.event_key);
      expect(await c.innerHits()).toEqual(hitsAfterFirst);
      expect(await c.events()).toHaveLength(1);
    });

    it("control: a spent inner budget still answers the true 429 envelope with Retry-After", async () => {
      const c = await caller();
      const created = await c.call({ op: "create", idempotency_key: randomUUID(), fields: FIELDS });
      expect(created.status).toBe(201);
      const eventKey = created.body.event_key as string;
      const limited = cfg({ readsPerMinute: 1, lockWaitMs: 50 });

      expect(
        (await c.call({ op: "read", idempotency_key: randomUUID(), event_key: eventKey }, limited))
          .status,
      ).toBe(200);
      const hitsBeforeRefusal = await c.innerHits();
      const refused = await c.call(
        { op: "read", idempotency_key: randomUUID(), event_key: eventKey },
        limited,
      );
      expect(refused.status).toBe(429);
      expect(refused.body.reason).toBe("rate_limited");
      expect(Number(refused.body.retry_after)).toBeGreaterThanOrEqual(1);
      expect(refused.headers?.["Retry-After"]).toBe(String(refused.body.retry_after));
      expect(refused.body).not.toHaveProperty("exception");
      expect(refused.body).not.toHaveProperty("trace");
      // A true rate refusal charges nothing.
      expect(await c.innerHits()).toEqual(hitsBeforeRefusal);
    });

    const busyCases = [
      {
        name: "service-read lock held, valid read",
        bucket: () => "service-read",
        op: "read",
        needsEvent: true,
        admittedStatus: 200,
      },
      {
        name: "service-mutating lock held, valid create",
        bucket: () => "service-mutating",
        op: "create",
        needsEvent: false,
        admittedStatus: 201,
      },
      {
        name: "grant read lock held, valid read",
        bucket: (grantId: string) => `read:${grantId}`,
        op: "read",
        needsEvent: true,
        admittedStatus: 200,
      },
      {
        name: "grant mutating lock held, valid create",
        bucket: (grantId: string) => `mutating:${grantId}`,
        op: "create",
        needsEvent: false,
        admittedStatus: 201,
      },
    ] as const;

    it.each(busyCases)(
      "settles 503 operation_busy while the inner lock is held: $name",
      async (busyCase) => {
        const c = await caller();
        let eventKey: string | undefined;
        if (busyCase.needsEvent) {
          const created = await c.call({
            op: "create",
            idempotency_key: randomUUID(),
            fields: FIELDS,
          });
          expect(created.status).toBe(201);
          eventKey = created.body.event_key as string;
        }
        const bucket = busyCase.bucket(c.grantId);
        const busyConfig = cfg({ lockWaitMs: 50 });
        const measuredKey = randomUUID();
        const measuredBody =
          busyCase.op === "read"
            ? { op: "read", idempotency_key: measuredKey, event_key: eventKey }
            : { op: "create", idempotency_key: measuredKey, fields: FIELDS };

        const hitsBefore = await c.innerHits();
        const eventsBefore = await c.events();
        expect(await c.auditsFor(measuredKey)).toHaveLength(0);
        expect(await c.stored(measuredKey)).toHaveLength(0);

        const { done: holderDone } = await holdBucketLockDbDelayed(bucket, 1);
        let pending: Promise<Answer> | undefined;
        try {
          pending = c.call(measuredBody, busyConfig);
          // Direct await: the configured 50ms database lock_timeout settles
          // this before the holder's 1s database-side self-release. Arrival
          // of the 503 before that release IS the magnitude proof: a wait
          // ignoring lockWaitMs would still be blocked at 1s and be
          // admitted (200/201) instead of refused.
          const busy = await pending;

          // Every assertion below runs before the self-release resolves:
          // releasing first could let a hung request complete and mask it.
          expect(busy.status).toBe(503);
          expect(busy.body.reason).toBe("operation_busy");
          expect(busy.body.request_id).toBeTruthy();
          expect(busy.body).not.toHaveProperty("exception");
          expect(busy.body).not.toHaveProperty("trace");
          expect(busy.body).not.toHaveProperty("stack");

          // Audited once as a load error, never as a rate denial.
          const audits = await c.auditsFor(measuredKey);
          expect(audits).toHaveLength(1);
          expect(audits[0]).toMatchObject({
            result: "error",
            reason_code: "operation_busy",
            request_id: busy.body.request_id,
            operation: busyCase.op,
          });
          expect(
            audits.filter((r) => r.result === "denied" || r.reason_code === "rate_limited"),
          ).toHaveLength(0);

          // The busy refusal is free: no inner hits, no receipt, no mutation.
          expect(await c.innerHits()).toEqual(hitsBefore);
          expect(await c.stored(measuredKey)).toHaveLength(0);
          expect(await c.events()).toEqual(eventsBefore);
        } finally {
          // Wait out the holder's database-side schedule so no work dangles
          // into the next test (on the unbounded path it now completes).
          await holderDone;
          await pending?.catch(() => null);
        }

        // After release, normal admission succeeds with a fresh key.
        const admittedKey = randomUUID();
        const admittedBody =
          busyCase.op === "read"
            ? { op: "read", idempotency_key: admittedKey, event_key: eventKey }
            : { op: "create", idempotency_key: admittedKey, fields: FIELDS };
        const admitted = await c.call(admittedBody, busyConfig);
        expect(admitted.status).toBe(busyCase.admittedStatus);
        await c.secretFree();
      },
    );
  },
);
