/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type Answer } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import agentTables from "../drizzle/0001_agent-events.sql?raw";
import sharedEvents from "../drizzle/1001_admin-slice.sql?raw";
import rsvpSeats from "../drizzle/1002_rsvps.sql?raw";
import rsvpSyncStamp from "../drizzle/1006_rsvp-synced-at.sql?raw";
import syncFailure from "../drizzle/1009_event-sync-failure.sql?raw";
import rsvpLegacyOrder from "../drizzle/1010_rsvp-legacy-order.sql?raw";
import icsSequence from "../drizzle/1014_event-ics-sequence.sql?raw";
import sharedAgentColumns from "../drizzle/1015_shared-agent-events.sql?raw";
import { testDatabaseUrl } from "./helpers/member-data-db";

const cfg = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: "synthetic-cross-operation",
  lockWaitMs: 10000,
};
const FIELDS = {
  title: "Cross-operation proof",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Synthetic fixture",
  capacity: 4,
};
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Attempt = { answer: Answer } | { error: string | undefined };
const attempt = (request: Promise<Answer>): Promise<Attempt> =>
  request.then(
    (answer) => ({ answer }),
    (error: { code?: string }) => ({ error: error.code }),
  );
const summary = (result: Attempt) =>
  "answer" in result ? { status: result.answer.status, reason: result.answer.body.reason } : result;

// The existing URL guard refuses non-test targets and query overrides before
// postgres() or DDL. Every write below resolves within this disposable schema.
describe.skipIf(!process.env.DATABASE_URL)(
  "cross-operation idempotency (owned Postgres schema)",
  () => {
    const schemaName = `agent_idem_${randomUUID().replaceAll("-", "")}`;
    const clients: postgres.Sql[] = [];
    let url: URL;
    let admin: postgres.Sql;
    let setup: postgres.Sql;
    let created = false;
    let n = 0;
    function client(role: string) {
      const sql = postgres(url.href, {
        max: 1,
        connect_timeout: 5,
        password: () => url.password,
        onnotice: () => {},
        connection: { search_path: schemaName, application_name: `${schemaName}_${role}` },
      });
      clients.push(sql);
      return sql;
    }
    beforeAll(async () => {
      url = testDatabaseUrl(process.env.DATABASE_URL!);
      admin = postgres(url.href, {
        max: 1,
        connect_timeout: 5,
        password: () => url.password,
        onnotice: () => {},
      });
      await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
      created = true;
      setup = client("setup");
      // The merged ingress acts on the shared `events` rows: the agent tables
      // from 0001, the shared events table from 1001, the seat tally from 1002,
      // later additive columns the shared-row queries select (1006/1009/1010
      // and 1014 without its backfill UPDATE, which needs no rows here), then
      // the agent ownership columns from 1015 (without its data migration — no
      // retired rows exist in this fresh schema).
      const columnAdds = sharedAgentColumns
        .split("--> statement-breakpoint")
        .slice(0, 5)
        .join("--> statement-breakpoint");
      const icsColumns = icsSequence.split("--> statement-breakpoint")[0]!;
      for (const migration of [
        agentTables,
        sharedEvents,
        rsvpSeats,
        rsvpSyncStamp,
        syncFailure,
        rsvpLegacyOrder,
        icsColumns,
        columnAdds,
      ]) {
        for (const statement of migration
          .replaceAll('"public".', `"${schemaName}".`)
          .split("--> statement-breakpoint")) {
          if (statement.trim()) await setup.unsafe(statement);
        }
      }
    });
    afterAll(async () => {
      try {
        await Promise.all(clients.map((sql) => sql.end({ timeout: 2 })));
        if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await admin?.end({ timeout: 2 });
      }
    });
    async function fixture() {
      const token = `synthetic-${schemaName}-${++n}`;
      const [grant] =
        await setup`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${cfg.callerAgentId}, 'synthetic-company', ${cfg.stagingGuildId}, ${await sha256Hex(token)}) RETURNING id`;
      const result = await handleAgentEvent(
        setup,
        cfg,
        { op: "create", idempotency_key: `create-${n}`, fields: FIELDS },
        token,
      );
      expect(result.status).toBe(201);
      return { token, grantId: grant!.id as string, eventKey: result.body.event_key as string };
    }
    async function waitForLock(role: string) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await admin`SELECT pid, query, wait_event, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE application_name = ${`${schemaName}_${role}`}
        AND state = 'active' AND wait_event_type = 'Lock'`;
        if (row && row.blockers.length > 0) return row;
      }
      throw new Error(`No observed lock wait for ${role}`);
    }

    it.each([true, false])(
      "update then read sharing K return success/conflict (explicit read key: %s)",
      async (explicit) => {
        const { token, grantId, eventKey } = await fixture();
        const key = `cross-${n}`;
        const holder = client(`holder-${n}`);
        const writer = client(`update-${n}`);
        const reader = client(`read-${n}`);
        const ready = barrier();
        const release = barrier();
        let holderPid = 0;
        const held = holder.begin(async (tx) => {
          holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid;
          await tx`SELECT event_key FROM events WHERE event_key = ${eventKey} FOR UPDATE`;
          ready.release();
          await release.promise;
        });
        const heldResult = held.then(
          () => null,
          (error: unknown) => {
            ready.release();
            return error;
          },
        );
        let updated: Promise<Attempt> | undefined;
        let read: Promise<Attempt> | undefined;
        let heldError: unknown = null;
        try {
          await ready.promise;
          updated = attempt(
            handleAgentEvent(
              writer,
              cfg,
              {
                op: "update",
                idempotency_key: key,
                event_key: eventKey,
                version: 1,
                fields: { ...FIELDS, title: "Updated once" },
              },
              token,
            ),
          );
          const updateWait = await waitForLock(`update-${n}`);
          expect(updateWait.query).toMatch(/SELECT \* FROM events .*FOR UPDATE/);
          expect(updateWait.blockers).toContain(holderPid);
          read = attempt(
            handleAgentEvent(
              reader,
              cfg,
              {
                op: "read",
                idempotency_key: key,
                ...(explicit ? { event_key: eventKey } : {}),
              },
              token,
            ),
          );
          const readWait = await waitForLock(`read-${n}`);
          // Pre-fix read passed the transactional replay lookup and waits in the
          // row/tuple queue. With key serialization, it waits on the writer's lock.
          expect(readWait.query).toMatch(
            /SELECT \* FROM events .*FOR UPDATE|pg_advisory_xact_lock/,
          );
          expect(readWait.blockers).toContain(updateWait.pid);
          console.info("observed schedule", {
            updateWait: updateWait.wait_event,
            readWait: readWait.wait_event,
            readReachedRow: readWait.query.includes("FOR UPDATE"),
          });
        } finally {
          release.release();
          heldError = await heldResult;
          await Promise.all([updated, read]);
        }
        if (heldError) throw heldError;
        const results = await Promise.all([updated!, read!]);
        const [event] =
          await setup`SELECT agent_version, title FROM events WHERE event_key = ${eventKey}`;
        const stored =
          await setup`SELECT status, event_key, body FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`;
        const receipts =
          await setup`SELECT operation, result, reason_code, request_id FROM agent_event_audits
      WHERE grant_id = ${grantId} AND idempotency_key = ${key} ORDER BY id`;
        console.info("post-commit evidence", {
          results: results.map(summary),
          version: event!.agent_version,
          stored: stored.length,
          receipts: receipts.map(({ operation, result, reason_code }) => ({
            operation,
            result,
            reason_code,
          })),
        });
        expect(results.map(summary)).toEqual([
          { status: 200, reason: undefined },
          { status: 409, reason: "idempotency_conflict" },
        ]);
        expect(event).toMatchObject({ agent_version: 2, title: "Updated once" });
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          status: 200,
          event_key: eventKey,
          body: { agent_version: 2 },
        });
        expect(receipts).toMatchObject([
          { operation: "update", result: "ok", reason_code: null },
          { operation: "read", result: "conflict", reason_code: "idempotency_conflict" },
        ]);
        expect(new Set(receipts.map((r) => r.request_id)).size).toBe(2);
      },
    );

    async function withLock(
      acquire: (tx: postgres.TransactionSql) => Promise<unknown>,
      run: () => Promise<void>,
    ) {
      const holder = client(`extra-holder-${n}`);
      const ready = barrier();
      const release = barrier();
      const held = holder.begin(async (tx) => {
        await acquire(tx);
        ready.release();
        await release.promise;
      });
      const heldResult = held.then(
        () => null,
        (error: unknown) => {
          ready.release();
          return error;
        },
      );
      await ready.promise;
      let heldError: unknown = null;
      try {
        await run();
      } finally {
        release.release();
        heldError = await heldResult;
      }
      if (heldError) throw heldError;
    }

    it("identical create and update payloads replay their stored success without mutating twice", async () => {
      const { token, grantId, eventKey } = await fixture();
      const create = await handleAgentEvent(
        setup,
        cfg,
        { op: "create", idempotency_key: `create-${n}`, fields: FIELDS },
        token,
      );
      expect(create).toMatchObject({
        status: 201,
        body: { replayed: true, event_key: eventKey, agent_version: 1 },
      });
      const key = `duplicate-${n}`;
      const request = {
        op: "update",
        idempotency_key: key,
        event_key: eventKey,
        version: 1,
        fields: FIELDS,
      };
      const writer = client(`duplicate-first-${n}`);
      const reader = client(`duplicate-second-${n}`);
      let first!: Promise<Attempt>;
      let second!: Promise<Attempt>;
      await withLock(
        (tx) => tx`SELECT event_key FROM events WHERE event_key = ${eventKey} FOR UPDATE`,
        async () => {
          first = attempt(handleAgentEvent(writer, cfg, request, token));
          const owner = await waitForLock(`duplicate-first-${n}`);
          second = attempt(handleAgentEvent(reader, cfg, request, token));
          const waiter = await waitForLock(`duplicate-second-${n}`);
          expect(waiter.query).toContain("pg_advisory_xact_lock");
          expect(waiter.blockers).toContain(owner.pid);
        },
      );
      expect(await first).toMatchObject({ answer: { status: 200, body: { agent_version: 2 } } });
      expect(await second).toMatchObject({
        answer: { status: 200, body: { replayed: true, agent_version: 2 } },
      });
      expect(
        (await setup`SELECT agent_version FROM events WHERE event_key = ${eventKey}`)[0]!
          .agent_version,
      ).toBe(2);
      expect(
        await setup`SELECT key FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`,
      ).toHaveLength(1);
    });

    it.each(["key", "row"])(
      "%s contention remains bounded, audited, and retryable",
      async (lock) => {
        const { token, grantId, eventKey } = await fixture();
        const key = `timeout-${n}`;
        const role = `timeout-${n}`;
        const writer = client(role);
        const request = {
          op: "update",
          idempotency_key: key,
          event_key: eventKey,
          version: 1,
          fields: FIELDS,
        };
        await withLock(
          (tx) =>
            lock === "key"
              ? tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-idempotency:${grantId}:${key}`}, 0))`
              : tx`SELECT event_key FROM events WHERE event_key = ${eventKey} FOR UPDATE`,
          async () => {
            const pending = attempt(
              handleAgentEvent(writer, { ...cfg, lockWaitMs: 200 }, request, token),
            );
            const waited = await waitForLock(role);
            expect(waited.query).toMatch(lock === "key" ? /pg_advisory_xact_lock/ : /FOR UPDATE/);
            const denied = await pending;
            expect(denied).toMatchObject({
              answer: { status: 503, body: { reason: "operation_busy" } },
            });
            expect(
              await setup`SELECT key FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`,
            ).toHaveLength(0);
            expect(
              await setup`SELECT result, reason_code FROM agent_event_audits WHERE grant_id = ${grantId} AND idempotency_key = ${key}`,
            ).toMatchObject([{ result: "error", reason_code: "operation_busy" }]);
          },
        );
        expect(await handleAgentEvent(writer, cfg, request, token)).toMatchObject({
          status: 200,
          body: { agent_version: 2 },
        });
      },
    );

    it("the same key on another grant does not wait for a held operation", async () => {
      const owned = await fixture();
      const other = await fixture();
      const key = `grant-scope-${n}`;
      const role = `grant-owner-${n}`;
      const writer = client(role);
      const reader = client(`grant-other-${n}`);
      let pending!: Promise<Attempt>;
      await withLock(
        (tx) => tx`SELECT event_key FROM events WHERE event_key = ${owned.eventKey} FOR UPDATE`,
        async () => {
          pending = attempt(
            handleAgentEvent(
              writer,
              cfg,
              {
                op: "update",
                idempotency_key: key,
                event_key: owned.eventKey,
                version: 1,
                fields: FIELDS,
              },
              owned.token,
            ),
          );
          await waitForLock(role);
          // A global key lock would time out while the first call is still held.
          expect(
            await handleAgentEvent(
              reader,
              { ...cfg, lockWaitMs: 200 },
              { op: "read", idempotency_key: key },
              other.token,
            ),
          ).toMatchObject({ status: 200 });
        },
      );
      expect(await pending).toMatchObject({ answer: { status: 200 } });
      expect(
        await setup`SELECT key FROM agent_event_idempotency_keys WHERE key = ${key}`,
      ).toHaveLength(2);
    });
  },
);
