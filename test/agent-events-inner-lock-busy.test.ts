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
// JavaScript clock: every busy case holds its lock until the measured
// verdict arrives, with a database-side self-release as backstop. The holder
// acquires first (handshake); the measured call runs on a dedicated
// connection while an observer polls pg_stat_activity for the measured
// backend blocked by the holder. The 1s pg_sleep self-release starts only
// after that block is observed, so pre-lock scheduling stalls (grant and
// replay lookups under full-suite CI load) no longer consume the proof
// window. A wait honoring the configured 50ms answers 503 long before the
// 1s release; a wait ignoring it (the 1500ms test default or the 5s product
// default) is still blocked at release time, sees the lock free, and is
// admitted (200/201) instead of refused, failing the status assert.
//
// Lock acquisition is coordinated explicitly: the holder's advisory-lock
// query resolving inside its open transaction is the handshake that the
// lock is held, and the observer's blocked row (measured pid waiting on a
// Lock with the holder in pg_blocking_pids) is the handshake that the
// measured wait began. Arrival of the 503 verdict before the observer-timed
// self-release IS the proof the configured lockWaitMs database lock_timeout
// fired. An admitted verdict without any observed block, or neither verdict
// nor block within 8s, fails with a stall-specific message, distinct from
// the magnitude failure. An unbounded wait hangs past the vitest test
// timeout instead. No wall-clock race, no fake timers, no timing-only sleep
// proves anything here: the 8s JavaScript ceiling is liveness only.
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
      const callOn = (
        client: postgres.Sql,
        body: unknown,
        config: IngressConfig = cfg(),
      ): Promise<Answer> => handleAgentEvent(client, config, body, credential, null);
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
      return { call, callOn, innerHits, auditsFor, stored, events, secretFree, grantId };
    }

    // Hold `agent-event-hits:<bucket>` until the caller releases it. The await
    // resolves only once the lock is actually held (handshake); the caller
    // then either releases immediately (verdict already observed) or starts
    // the database-side self-release once the measured backend is observed
    // blocked. The self-release stays on the database clock, timed from the
    // observation rather than the acquisition, so pre-lock scheduling stalls
    // never consume the magnitude window. A measured wait honoring the
    // configured 50ms answers 503 before that release; a wait ignoring it is
    // still blocked at release time, sees the lock free, and is admitted
    // instead.
    async function openBucketHolder(bucket: string): Promise<{
      holderPid: number;
      releaseNow: () => Promise<void>;
      sleepThenRelease: (secs: number) => Promise<void>;
    }> {
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      const holder = postgres(url.href, {
        max: 1,
        port: 5432,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      let released = false;
      const releaseNow = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await holder.unsafe("ROLLBACK");
        } catch {
          // Already closed; the lock is gone either way.
        }
        await holder.end().catch(() => {});
      };
      await holder.unsafe("BEGIN");
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${"agent-event-hits:" + bucket}, 0))`;
      const [self] = await holder`SELECT pg_backend_pid() AS pid`;
      const holderPid = self!.pid as number;
      return {
        holderPid,
        releaseNow,
        sleepThenRelease: async (secs: number): Promise<void> => {
          try {
            await holder.unsafe(`SELECT pg_sleep(${secs})`);
          } finally {
            await releaseNow();
          }
        },
      };
    }

    // A dedicated backend for the measured call so the observer can attribute
    // a Lock wait to it by pid. Single connection: the pid read here is the
    // pid that later blocks on the held advisory lock.
    async function openMeasuredClient(): Promise<{
      measured: postgres.Sql;
      measuredPid: number;
    }> {
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      const measured = postgres(url.href, {
        max: 1,
        port: 5432,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      const [self] = await measured`SELECT pg_backend_pid() AS pid`;
      return { measured, measuredPid: self!.pid as number };
    }

    // Poll until the measured backend is observed waiting on a Lock held by
    // the holder (true), the verdict settles first (false), or the liveness
    // ceiling passes (false). The ceiling is not proof: it only turns a hung
    // pre-lock path into a stall-specific failure instead of a vitest timeout.
    async function waitForBlockedOn(
      measuredPid: number,
      holderPid: number,
      settled: () => boolean,
      timeoutMs = 8000,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (settled()) return false;
        const rows = await sql`SELECT 1 AS blocked FROM pg_stat_activity
          WHERE pid = ${measuredPid} AND wait_event_type = 'Lock'
            AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        if (rows.length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
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

        const holder = await openBucketHolder(bucket);
        const { measured, measuredPid } = await openMeasuredClient().catch(async (error) => {
          await holder.releaseNow();
          throw error;
        });
        let holderDone: Promise<void> | null = null;
        try {
          let settled = false;
          const pending = c.callOn(measured, measuredBody, busyConfig);
          void pending.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          // Observe the block before timing the release: the 1s database-side
          // self-release starts only after the measured backend is seen
          // waiting on the holder, so CI-load pre-lock latency cannot spend
          // the proof window. A 503 that lands before any observation is the
          // fast path — the 50ms lock_timeout fired inside a poll gap — and
          // the holder is released immediately with nothing dangling.
          const blocked = await waitForBlockedOn(measuredPid, holder.holderPid, () => settled);
          // Let a just-arrived verdict mark the flag before branching, so a
          // verdict racing the deadline is judged as settled, not timed out.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (!blocked && !settled) {
            throw new Error(
              `inner-lock-busy scheduling stall: no verdict and no observed block within 8s for ${busyCase.name} (holder pid ${holder.holderPid}, measured pid ${measuredPid})`,
            );
          }
          if (blocked) holderDone = holder.sleepThenRelease(1);
          const busy = await pending;
          if (!blocked && busy.status !== 503) {
            throw new Error(
              `inner-lock-busy scheduling stall: admitted ${busy.status} without any observed lock wait for ${busyCase.name} (holder pid ${holder.holderPid}, measured pid ${measuredPid}); the pre-lock path outran the holder or the wait bypassed the inner lock`,
            );
          }

          // Every assertion below runs before the self-release resolves on the
          // observed path (a hung request would have been admitted and failed
          // the status assert); on the fast path the holder releases after the
          // verdict in the finally below.
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
          // On the observed path wait out the database-side schedule so no
          // work dangles into the next test (on the unbounded path it now
          // completes); on the fast path release immediately. releaseNow is
          // idempotent, so observer failures still clean up.
          if (holderDone) await holderDone;
          else await holder.releaseNow();
          await measured.end().catch(() => {});
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
