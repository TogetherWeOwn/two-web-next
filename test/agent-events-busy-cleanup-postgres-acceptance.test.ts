// Test-author owned. Only guarded, schema-owned disposable PostgreSQL fixtures.
// Timers below detect hangs; held peers, SQLSTATE, rollback and pool reuse are
// the proof. A JavaScript race must not be the implementation's cancellation.
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type Answer } from "../src/agent-events/service";
import { rateLimit } from "../src/agent-events/rate-limit";
import { shield } from "../src/agent-events/shield";
import { sha256Hex } from "../src/bot/signer";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { pruneClient, within } from "./helpers/prune-contention";

const cfg = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: "busy-cleanup-fixture",
  lockWaitMs: 73.8,
};
const fields = {
  title: "Busy cleanup fixture",
  game: "Chess",
  description: "Synthetic fixture only",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Fixture",
  capacity: 2,
};
const cleanupCases = [
  "inner-admit",
  "inner-refuse",
  "inner-busy",
  "outer-admit",
  "outer-refuse",
] as const;

type Seen = { inTx: boolean; lock: string; statement: string; requestId?: unknown };
// Observe actual server state at the query boundary, rather than trusting SQL
// strings or settings on a different transaction. Root calls stay root calls.
function observe(raw: postgres.Sql, beforeAudit?: () => Promise<void>) {
  const audits: Seen[] = [];
  const deletes: Seen[] = [];
  const errors: { kind: string; code: string }[] = [];
  let settled = true;
  function wrap(client: postgres.Sql, inTx: boolean): postgres.Sql {
    return new Proxy(client, {
      apply(target, _self, args) {
        const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
        const text = strings.join(" ").toLowerCase();
        const kind = text.includes("insert into agent_event_audits")
          ? "audit"
          : text.includes("delete from agent_event_hits")
            ? "cleanup"
            : "other";
        if (kind === "other") return Reflect.apply(target, target, args);
        return (async () => {
          const [settings] = await target`select current_setting('lock_timeout') as lock,
            current_setting('statement_timeout') as statement`;
          const seen = {
            inTx,
            lock: settings!.lock as string,
            statement: settings!.statement as string,
            ...(kind === "audit" ? { requestId: values[5] } : {}),
          };
          (kind === "audit" ? audits : deletes).push(seen);
          if (kind === "audit") await beforeAudit?.();
          try {
            return await Reflect.apply(target, target, args);
          } catch (error) {
            errors.push({ kind, code: (error as { code: string }).code });
            throw error;
          }
        })();
      },
      get(target, key) {
        if (key === "begin")
          return async (fn: (tx: postgres.Sql) => Promise<unknown>) => {
            settled = false;
            try {
              return await target.begin((tx) => fn(wrap(tx as unknown as postgres.Sql, true)));
            } finally {
              settled = true;
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return { sql: wrap(raw, false), audits, deletes, errors, settled: () => settled };
}

// Existing project convention: live cases are enabled by DATABASE_URL; its
// allowlist is enforced before client construction by createJobsFixture.
describe.skipIf(!process.env.DATABASE_URL)(
  "bounded busy audits and post-verdict cleanup (Postgres)",
  () => {
    let fixture: JobsFixture;
    let sql: postgres.Sql;
    let measured: postgres.Sql;
    let holder: postgres.Sql;
    let blocker: postgres.Sql;
    let pid: number;
    const token = `synthetic-busy-${randomUUID()}`;
    let hash: string;
    let grantId: string;

    // A fresh schema per case preserves the append-only audit contract.
    beforeEach(async () => {
      fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 2 });
      sql = fixture.client;
      measured = pruneClient(fixture.schemaName, "busy_cleanup_measured");
      holder = pruneClient(fixture.schemaName, "busy_cleanup_audit_holder");
      blocker = pruneClient(fixture.schemaName, "busy_cleanup_admission_holder");
      pid = (await measured`select pg_backend_pid() as pid`)[0]!.pid;
      hash = await sha256Hex(token);
      const [grant] =
        await sql`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      values (${cfg.callerAgentId}, 'fixture-company', ${cfg.stagingGuildId}, ${hash}) returning id`;
      grantId = grant!.id;
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await measured?.end({ timeout: 1 });
      await holder?.end({ timeout: 1 });
      await blocker?.end({ timeout: 1 });
      await fixture?.dispose();
    });
    const grant = () => ({
      id: grantId,
      agent_id: cfg.callerAgentId,
      guild_id: cfg.stagingGuildId,
      expires_at: null,
      disabled_at: null,
    });
    const call = (client: postgres.Sql, key = "busy-fixture-key") =>
      handleAgentEvent(
        client,
        cfg,
        {
          op: "create",
          idempotency_key: key,
          fields,
        },
        token,
      );
    const count = async (bucket: string) =>
      (await sql`select count(*)::int as n from agent_event_hits where bucket = ${bucket}`)[0]!
        .n as number;
    async function reusable(observed: ReturnType<typeof observe>) {
      expect(observed.settled(), "TRANSACTION_NOT_SETTLED: await rollback before return").toBe(
        true,
      );
      const [state] = await within(
        measured`select 1 as ok, current_setting('statement_timeout') as statement,
      current_setting('lock_timeout') as lock`,
        2500,
      );
      expect(state).toMatchObject({ ok: 1, statement: "0", lock: "0" });
      const [activity] =
        await sql`select state, xact_start is null as idle from pg_stat_activity where pid = ${pid}`;
      expect(activity).toMatchObject({ state: "idle", idle: true });
    }
    async function noOperation() {
      expect(await sql`select id from events where agent_grant_id = ${grantId}`).toHaveLength(0);
      expect(
        await sql`select key from agent_event_idempotency_keys where grant_id = ${grantId}`,
      ).toHaveLength(0);
      expect(await count(`mutating:${grantId}`)).toBe(0);
      expect(await count("service-mutating")).toBe(0);
    }

    it.each(["outer", "inner"] as const)(
      "BA-PG-%s-control: one writable busy audit, then same-key retry and free replay",
      async (layer) => {
        const bucket = layer === "outer" ? `shield:${hash}` : "service-mutating";
        await blocker.unsafe("BEGIN");
        try {
          await blocker`select pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`},0))`;
          const answer = await within(call(measured), 2500);
          expect(answer.status).toBe(503);
          expect(answer.body).toMatchObject({
            code: "operation_busy",
            next: "Retry with the same idempotency key.",
          });
          const rows = await sql`select * from agent_event_audits`;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            grant_id: layer === "outer" ? null : grantId,
            operation: layer === "outer" ? "unknown" : "create",
            event_key: null,
            idempotency_key: layer === "outer" ? null : "busy-fixture-key",
            request_id: answer.body.request_id,
            result: "error",
            reason_code: "operation_busy",
          });
          expect(rows[0]!.payload_digest).toEqual(
            layer === "outer" ? null : expect.stringMatching(/^[a-f0-9]{64}$/),
          );
          expect(JSON.stringify(rows)).not.toContain(token);
          await noOperation();
        } finally {
          await blocker.unsafe("ROLLBACK");
        }
        const created = await call(measured);
        expect(created.status).toBe(201);
        expect(await count(`mutating:${grantId}`)).toBe(1);
        const replay = await call(measured);
        expect(replay.status).toBe(201);
        expect(replay.body).toMatchObject({ event_key: created.body.event_key, replayed: true });
        expect(await count(`mutating:${grantId}`)).toBe(1);
        expect(
          await sql`select key from agent_event_idempotency_keys where grant_id = ${grantId}`,
        ).toHaveLength(1);
        expect(await sql`select id from events where agent_grant_id = ${grantId}`).toHaveLength(1);
      },
    );

    it.each(["outer", "inner"] as const)(
      "BA-PG-%s-429-control: budget exhaustion remains an audited 429",
      async (layer) => {
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        try {
          if (layer === "outer")
            await sql`insert into agent_event_hits (bucket) values (${`shield:${hash}`})`;
          const answer = await handleAgentEvent(
            measured,
            {
              ...cfg,
              ...(layer === "outer" ? { routePerMinute: 1 } : { mutatingPerMinute: 0 }),
            },
            { op: "create", idempotency_key: "429-key", fields },
            token,
          );
          expect(answer.status).toBe(429);
          expect(answer.body).toMatchObject({
            code: "rate_limited",
            reason: "rate_limited",
            next: "Wait for Retry-After, then retry with the same key.",
          });
          expect(answer.headers?.["Retry-After"]).toBe(String(answer.body.retry_after));
          expect(Number(answer.body.retry_after)).toBeGreaterThanOrEqual(1);
          const rows = await sql`select * from agent_event_audits`;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            result: "denied",
            reason_code: "rate_limited",
            request_id: answer.body.request_id,
          });
          await noOperation();
        } finally {
          random.mockRestore();
        }
      },
    );

    it("CL-PG-cap-control: normal cleanup retains the five-minute cutoff and 1000-row cap", async () => {
      await sql`insert into agent_event_hits (bucket, at) select 'stale',now() - interval '10 minutes' from generate_series(1,1005)`;
      await sql`insert into agent_event_hits (bucket, at) values ('fresh',now() - interval '4 minutes')`;
      expect(await rateLimit(measured, cfg, grant(), "read")).toBeNull();
      expect(await count("stale")).toBe(5);
      expect(await count("fresh")).toBe(1);
      expect(await rateLimit(measured, cfg, grant(), "read")).toBeNull();
      expect(await count("stale")).toBe(0);
      expect(await count("fresh")).toBe(1);
    });

    it.each(["outer", "inner"] as const)(
      "BA-PG-%s-lock: answers while the independent audit-table holder is parked",
      async (layer) => {
        const observed = observe(measured, async () => {
          // Check from a peer before the INSERT, not after reporting returns:
          // inner admission took this grant lock before blocking on service.
          await sql.begin(async (tx) => {
            const [free] =
              await tx`select pg_try_advisory_xact_lock(hashtextextended(${`agent-event-hits:mutating:${grantId}`},0)) as free`;
            expect(free!.free, "ADMISSION_LOCK_RETAINED: release before busy reporting").toBe(true);
          });
        });
        const bucket = layer === "outer" ? `shield:${hash}` : "service-mutating";
        let pending: Promise<Answer> | undefined;
        let released = false;
        await blocker.unsafe("BEGIN");
        await holder.unsafe("BEGIN");
        try {
          await blocker`select pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`}, 0))`;
          await holder.unsafe("LOCK TABLE agent_event_audits IN ACCESS EXCLUSIVE MODE");
          pending = call(observed.sql);
          // Holder is released only in finally, never on a timer. An unbounded
          // audit therefore fails instead of being rescued into a false success.
          const answer = await within(pending, 2500);
          expect(released).toBe(false);
          expect(answer.status).toBe(503);
          expect(answer.body).toMatchObject({
            code: "operation_busy",
            reason: "operation_busy",
            next: "Retry with the same idempotency key.",
            request_id: observed.audits[0]!.requestId,
          });
          expect(observed.audits).toHaveLength(1);
          expect(observed.audits[0]).toMatchObject({ inTx: true, lock: "73ms", statement: "73ms" });
          expect(observed.errors).toHaveLength(1);
          expect(observed.errors[0]!.kind).toBe("audit");
          // Equal lock/statement deadlines can race; either PostgreSQL
          // timeout is expected here. The sleep case isolates 57014.
          expect(["55P03", "57014"]).toContain(observed.errors[0]!.code);
          await noOperation();
          expect(await count(`shield:${hash}`)).toBe(layer === "outer" ? 0 : 1);
          await reusable(observed);
          // The other inner bucket is not retained during reporting.
          await sql.begin(async (tx) => {
            const [free] =
              await tx`select pg_try_advisory_xact_lock(hashtextextended(${`agent-event-hits:mutating:${grantId}`},0)) as free`;
            expect(free!.free).toBe(true);
          });
        } finally {
          await sql`select pg_cancel_backend(${pid})`;
          await holder.unsafe("ROLLBACK");
          await blocker.unsafe("ROLLBACK");
          released = true;
          await pending?.catch(() => {});
        }
        expect(await sql`select id from agent_event_audits`).toHaveLength(0);
        // Same key was not spent by the busy attempt; the successful retry stores
        // one event/receipt and its next replay spends no inner budget.
        const created = await call(measured);
        expect(created.status).toBe(201);
        const before = await count(`mutating:${grantId}`);
        const replay = await call(measured);
        expect(replay.status).toBe(201);
        expect(replay.body.replayed).toBe(true);
        expect(replay.body.event_key).toBe(created.body.event_key);
        expect(await count(`mutating:${grantId}`)).toBe(before);
      },
    );

    it.each(["outer", "inner"] as const)(
      "BA-PG-%s-statement: cancels slow audit SQL without changing the busy answer",
      async (layer) => {
        const observed = observe(measured);
        const bucket = layer === "outer" ? `shield:${hash}` : "service-mutating";
        await sql.unsafe(`create function slow_busy_audit() returns trigger language plpgsql as $$
      begin perform pg_sleep(30); return NEW; end $$`);
        await sql.unsafe(`create trigger slow_busy_audit after insert on agent_event_audits
      for each row execute function slow_busy_audit()`);
        let pending: Promise<Answer> | undefined;
        await blocker.unsafe("BEGIN");
        try {
          await blocker`select pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`},0))`;
          pending = call(observed.sql);
          const answer = await within(pending, 2500);
          expect(answer.status).toBe(503);
          expect(answer.body).toMatchObject({
            code: "operation_busy",
            request_id: observed.audits[0]!.requestId,
            next: "Retry with the same idempotency key.",
          });
          expect(JSON.stringify(answer)).not.toMatch(/pg_sleep|57014|exception|stack/);
          expect(observed.audits).toHaveLength(1);
          expect(observed.errors).toContainEqual({ kind: "audit", code: "57014" });
          expect(await sql`select id from agent_event_audits`).toHaveLength(0);
          await noOperation();
          await reusable(observed);
        } finally {
          await sql`select pg_cancel_backend(${pid})`;
          await blocker.unsafe("ROLLBACK");
          await pending?.catch(() => {});
          await sql.unsafe("drop trigger slow_busy_audit on agent_event_audits");
          await sql.unsafe("drop function slow_busy_audit()");
        }
      },
    );

    it.each(cleanupCases)(
      "CL-PG-%s: server-cancels slow cleanup after committing the verdict",
      async (verdict) => {
        vi.spyOn(Math, "random").mockReturnValue(1); // Keep outer 429 sampling out of the cleanup proof.
        const observed = observe(measured);
        await sql`insert into agent_event_hits (bucket, at) values ('stale',now() - interval '10 minutes'), ('fresh',now() - interval '4 minutes')`;
        if (verdict === "inner-refuse")
          await sql`insert into agent_event_hits (bucket) values (${`read:${grantId}`})`;
        if (verdict === "outer-refuse")
          await sql`insert into agent_event_hits (bucket) values (${`shield:${hash}`})`;
        await sql.unsafe(`create function slow_hits_cleanup() returns trigger language plpgsql as $$
      begin perform pg_sleep(30); return OLD; end $$`);
        await sql.unsafe(`create trigger slow_hits_cleanup after delete on agent_event_hits
      for each statement execute function slow_hits_cleanup()`);
        await blocker.unsafe("BEGIN");
        let pending: Promise<Answer | null> | undefined;
        try {
          if (verdict === "inner-busy")
            await blocker`select pg_advisory_xact_lock(hashtextextended('agent-event-hits:service-read',0))`;
          pending = verdict.startsWith("inner")
            ? rateLimit(
                observed.sql,
                { ...cfg, readsPerMinute: 1 },
                grant(),
                "read",
                "cleanup-request",
              )
            : shield(observed.sql, { ...cfg, routePerMinute: 1 }, hash, "cleanup-request", {
                kind: "credential",
                hash,
              });
          const answer = await within(pending, 2500);
          if (verdict.endsWith("admit")) expect(answer).toBeNull();
          else {
            expect(answer?.status).toBe(verdict === "inner-busy" ? 503 : 429);
            expect(answer?.body.request_id).toBe("cleanup-request");
            if (answer?.status === 429)
              expect(answer.headers?.["Retry-After"]).toBe(String(answer.body.retry_after));
          }
          expect(observed.deletes).toHaveLength(1);
          expect(observed.deletes[0]).toMatchObject({ inTx: true, lock: "1ms" });
          // Do not prescribe a particular constant: any explicit <=1s server
          // cleanup budget is small beside the existing 5s admission convention.
          const deadline = observed.deletes[0]!.statement;
          expect(
            deadline,
            "CLEANUP_UNBOUNDED: set a small transaction-local statement deadline",
          ).toMatch(/^\d+ms$|^1s$/);
          const ms = deadline.endsWith("ms") ? Number(deadline.slice(0, -2)) : 1000;
          expect(ms).toBeGreaterThan(0);
          expect(ms).toBeLessThanOrEqual(1000);
          expect(observed.errors).toContainEqual({ kind: "cleanup", code: "57014" });
          expect(await count("stale")).toBe(1);
          expect(await count("fresh")).toBe(1);
          expect(await count(`read:${grantId}`)).toBe(
            verdict === "inner-admit" || verdict === "inner-refuse" ? 1 : 0,
          );
          expect(await count("service-read")).toBe(verdict === "inner-admit" ? 1 : 0);
          expect(await count(`shield:${hash}`)).toBe(verdict.startsWith("outer") ? 1 : 0);
          await reusable(observed);
          await sql.begin(async (tx) => {
            const [free] =
              await tx`select pg_try_advisory_xact_lock(hashtextextended('agent-event-hits:prune',0)) as free`;
            expect(free!.free).toBe(true);
          });
        } finally {
          await sql`select pg_cancel_backend(${pid})`;
          await blocker.unsafe("ROLLBACK");
          await pending?.catch(() => {});
          await sql.unsafe("drop trigger slow_hits_cleanup on agent_event_hits");
          await sql.unsafe("drop function slow_hits_cleanup()");
          vi.restoreAllMocks();
        }
        // A later pass can acquire single-flight and drain normally after rollback.
        await rateLimit(measured, cfg, grant(), "read");
        expect(await count("stale")).toBe(0);
        expect(await count("fresh")).toBe(1);
      },
    );
  },
);
