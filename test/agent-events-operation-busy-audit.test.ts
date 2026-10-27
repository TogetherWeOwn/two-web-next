// Implementation-owned: the operation/idempotency-lock contention 503 must use
// the same bounded busy audit as the outer shield and inner limiter — its own
// short transaction with the admission's lock/statement deadlines, holding no
// admission lock. An expected audit timeout keeps the same retryable 503; an
// unexpected audit error propagates. (Author-owned BA-*/BA-PG-* suites pin the
// outer/inner paths; this file pins the third contention path without touching
// those files.)
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent } from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const credential = "synthetic-operation-busy-acceptance";
const grant = {
  id: "operation-busy-grant",
  agent_id: "operation-busy-caller",
  guild_id: DEFAULT_CONFIG.stagingGuildId,
  expires_at: null,
  disabled_at: null,
};
const body = { op: "create", idempotency_key: "operation-busy-key", fields: {} };
type Scope = { id: number; settings: string[]; settled: boolean; locks: string[] };
type Attempt = { scope: Scope | null; values: unknown[]; admissionSettled: boolean };

async function fixture(auditError?: Error) {
  const db = makeFakeAgentDb();
  await db.addGrant(credential, grant);
  const scopes: Scope[] = [];
  const attempts: Attempt[] = [];
  let active = 0;
  let operationWrites = 0;
  function wrap(raw: postgres.Sql, scope: Scope | null): postgres.Sql {
    return new Proxy(raw, {
      apply(target, _self, args) {
        const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
        const text = strings.join(" ").toLowerCase();
        if (text.includes("pg_try_advisory_xact_lock")) return Promise.resolve([{ got: true }]);
        if (text.includes("delete from agent_event_hits")) return Promise.resolve([]);
        if (text.includes("pg_advisory_xact_lock")) {
          const bucket = String(values[0]);
          scope?.locks.push(bucket);
          if (bucket === `agent-event-grant:${grant.id}`)
            return Promise.reject(
              Object.assign(new Error("synthetic operation lock"), { code: "55P03" }),
            );
        }
        if (text.includes("insert into agent_event_audits")) {
          attempts.push({
            scope,
            values,
            admissionSettled: scopes.filter((s) => s.locks.length > 0).every((s) => s.settled),
          });
          if (auditError) return Promise.reject(auditError);
        }
        if (
          text.includes("insert into events") ||
          text.includes("insert into agent_event_idempotency_keys")
        )
          operationWrites++;
        return Reflect.apply(target, target, args);
      },
      get(target, key) {
        if (key === "unsafe")
          return async (text: string) => {
            scope?.settings.push(text);
            return [];
          };
        if (key === "begin")
          return async (fn: (tx: postgres.Sql) => Promise<unknown>) => {
            const tx: Scope = { id: scopes.length + 1, settings: [], settled: false, locks: [] };
            scopes.push(tx);
            active++;
            try {
              return await fn(wrap(target, tx));
            } finally {
              tx.settled = true;
              active--;
            }
          };
        return Reflect.get(target, key);
      },
    });
  }
  const sql = wrap(db.sql, null);
  const call = (wait = 37.8) =>
    handleAgentEvent(
      sql,
      {
        ...DEFAULT_CONFIG,
        enabled: true,
        callerAgentId: grant.agent_id,
        lockWaitMs: wait,
      },
      body,
      credential,
    );
  return { db, call, scopes, attempts, active: () => active, writes: () => operationWrites };
}

describe("busy-audit operation acceptance", () => {
  it.each([37.8, 81.2])(
    "OP-bounds: audit uses its own local configured deadlines (%s)",
    async (wait) => {
      const f = await fixture();
      const answer = await f.call(wait);
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({
        code: "operation_busy",
        reason: "operation_busy",
        next: "Retry with the same idempotency key.",
      });
      expect(f.attempts).toHaveLength(1);
      const attempt = f.attempts[0]!;
      expect(
        attempt.scope,
        "BUSY_AUDIT_UNBOUNDED: use a separate short transaction",
      ).not.toBeNull();
      expect(attempt.scope!.settings).toEqual(
        expect.arrayContaining([
          `SET LOCAL lock_timeout = '${Math.floor(wait)}ms'`,
          `SET LOCAL statement_timeout = '${Math.floor(wait)}ms'`,
        ]),
      );
      expect(attempt.scope!.locks).toEqual([]);
      expect(
        attempt.admissionSettled,
        "ADMISSION_LOCK_RETAINED: settle admission before reporting",
      ).toBe(true);
      expect(f.active()).toBe(0);
      expect(f.writes()).toBe(0);
      expect(f.db.audits).toEqual([
        {
          grantId: grant.id,
          operation: "create",
          requestId: answer.body.request_id,
          result: "error",
          reason: "operation_busy",
        },
      ]);
      expect(attempt.values[3]).toBe(body.idempotency_key);
      expect(attempt.values[4]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
      // Shield plus both inner budget hits committed before the operation lock failed.
      expect(f.db.hits).toHaveLength(3);
    },
  );

  it.each(["55P03", "57014"])(
    "OP-timeout-%s: retains the same retryable envelope",
    async (code) => {
      const error = Object.assign(new Error("private synthetic audit exception"), { code });
      const f = await fixture(error);
      const answer = await f.call();
      expect(answer.status, "BUSY_AUDIT_TIMEOUT_ESCAPED: preserve operation_busy").toBe(503);
      expect(answer.body).toMatchObject({
        code: "operation_busy",
        reason: "operation_busy",
        next: "Retry with the same idempotency key.",
        request_id: f.attempts[0]!.values[5],
      });
      expect(answer.body.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(answer.headers ?? {}).not.toHaveProperty("Retry-After");
      expect(JSON.stringify(answer)).not.toMatch(/private synthetic|55P03|57014|stack|exception/);
      expect(f.attempts).toHaveLength(1);
      expect(f.db.audits).toEqual([]);
      expect(f.db.hits).toHaveLength(3);
      expect(f.writes()).toBe(0);
      expect(f.active()).toBe(0);
    },
  );

  it("OP-unexpected: propagates non-timeout audit diagnostics", async () => {
    const error = Object.assign(new Error("synthetic invariant failure"), { code: "23505" });
    const f = await fixture(error);
    await expect(f.call()).rejects.toBe(error);
    expect(f.attempts).toHaveLength(1);
    expect(f.writes()).toBe(0);
    expect(f.active()).toBe(0);
  });
});
