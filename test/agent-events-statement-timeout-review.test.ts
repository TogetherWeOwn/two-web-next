// Review follow-up for the statement-timeout bounds: pins the four blocking
// findings without touching the Test-Author owned acceptance file.
// - Wrapped cancellations (DrizzleQueryError.cause carrying PostgresError
//   57014/55P03, as on dispatch's pg-proxy update path) map to the audited
//   operation_busy 503 like top-level codes.
// - A grant deleted between lookup and the busy receipt does not turn the
//   retryable 503 into a 23503 500: the busy audit revalidates liveness and
//   attributes a vanished grant as null.
// - The deep-payload and inner-429 denial audits each run in their own bounded
//   transaction: reverting either call site to a bare audit fails these tests.
//
// Hermetic via the in-memory fake (no DATABASE_URL, no Discord, no network).
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
  type IngressEffects,
} from "../src/agent-events/service";
import { auditOperationBusy } from "../src/agent-events/audit";
import { isIngressBusy } from "../src/agent-events/deadline";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const credential = "synthetic-statement-timeout-review";
const grant = {
  id: "statement-timeout-review-grant",
  agent_id: "statement-timeout-review-caller",
  guild_id: DEFAULT_CONFIG.stagingGuildId,
  expires_at: null,
  disabled_at: null,
};
const FIELDS = {
  title: "Statement timeout review proof",
  game: "Chess",
  description: "Synthetic fixture event, never live.",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Fixture",
  capacity: 2,
};
const createBody = {
  op: "create",
  idempotency_key: "statement-timeout-review-key",
  fields: FIELDS,
};

type Scope = { id: number; settled: boolean; locks: string[]; events: Stmt[] };
type Stmt = { seq: number; scope: Scope | null; kind: string; text: string; values: unknown[] };
type Site = "replay-lookup" | "operation-work" | "deny-deep-audit" | "deny-rate-audit";

function classify(text: string): string {
  if (text.includes("pg_try_advisory_xact_lock")) return "try-lock";
  if (text.includes("delete from agent_event_hits")) return "prune-delete";
  if (text.includes("set local")) return "setting";
  if (text.includes("pg_advisory_xact_lock")) return "lock";
  if (text.includes("from agent_event_grants where verifier_hash")) return "grant-lookup";
  if (text.includes("from agent_event_idempotency_keys where grant_id")) return "replay-lookup";
  if (text.includes("insert into agent_event_idempotency_keys")) return "idem-insert";
  if (text.includes("insert into agent_event_audits")) return "audit-insert";
  if (text.includes("insert into agent_event_hits")) return "hit-insert";
  if (text.includes("agent_event_hits") && text.includes("count(*)")) return "hit-count";
  if (text.includes("insert into events")) return "event-insert";
  if (text.includes("expires_at_ms")) return "grant-check";
  return "other";
}

/** Drizzle-shaped wrapper: outer query error with no code, PostgresError in cause. */
function wrappedCancellation(code: string): Error {
  const cause = new Error("canceling statement due to statement timeout") as Error & {
    code: string;
  };
  cause.name = "PostgresError";
  cause.code = code;
  const outer = new Error(`Failed query: select ...`) as Error & { cause: unknown };
  outer.name = "DrizzleQueryError";
  outer.cause = cause;
  return outer;
}

async function fixture(inject?: { site: Site; error: unknown }, deleteGrantBeforeReplay = false) {
  const db = makeFakeAgentDb();
  await db.addGrant(credential, grant);
  const scopes: Scope[] = [];
  const stmts: Stmt[] = [];
  let seq = 0;
  let consumed = false;
  let replayLookups = 0;

  const hitsSite = (kind: string, values: unknown[]): boolean => {
    if (!inject) return false;
    switch (inject.site) {
      case "replay-lookup":
        return kind === "replay-lookup" && replayLookups === 1;
      case "operation-work":
        return kind === "event-insert";
      case "deny-deep-audit":
        return kind === "audit-insert" && values[7] === "payload_too_deep";
      case "deny-rate-audit":
        return (
          kind === "audit-insert" &&
          values[6] === "denied" &&
          values[7] === "rate_limited" &&
          values[0] === grant.id
        );
    }
  };

  function record(scope: Scope | null, kind: string, text: string, values: unknown[]): Stmt {
    const stmt: Stmt = { seq: ++seq, scope, kind, text, values };
    stmts.push(stmt);
    scope?.events.push(stmt);
    return stmt;
  }

  function wrap(raw: postgres.Sql, scope: Scope | null): postgres.Sql {
    return new Proxy(raw, {
      apply(target, _self, args) {
        const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
        const rawText = strings.join(" ");
        const text = rawText.toLowerCase();
        const kind = classify(text);
        if (kind === "replay-lookup") {
          replayLookups += 1;
          if (deleteGrantBeforeReplay && replayLookups === 1) db.removeGrantById(grant.id);
        }
        record(
          scope,
          kind,
          kind === "setting" ? rawText.replace(/\s+/g, " ").trim() : text,
          values,
        );
        if (kind === "try-lock") return Promise.resolve([{ got: true }]);
        if (kind === "prune-delete") return Promise.resolve([]);
        if (kind === "setting") return Promise.resolve([]);
        if (kind === "lock") scope?.locks.push(String(values[0]));
        if (hitsSite(kind, values) && !consumed) {
          consumed = true;
          return Promise.reject(inject!.error);
        }
        return Reflect.apply(target, target, args);
      },
      get(target, key) {
        if (key === "unsafe")
          return async (text: string) => {
            record(scope, "setting", text, []);
            return [];
          };
        if (key === "begin")
          return async (fn: (tx: postgres.Sql) => Promise<unknown>) => {
            const tx: Scope = { id: scopes.length + 1, settled: false, locks: [], events: [] };
            scopes.push(tx);
            try {
              return await fn(wrap(target, tx));
            } finally {
              tx.settled = true;
            }
          };
        return Reflect.get(target, key);
      },
    });
  }

  const sql = wrap(db.sql, null);
  const cfg = (overrides: Partial<IngressConfig> = {}): IngressConfig => ({
    ...DEFAULT_CONFIG,
    enabled: true,
    callerAgentId: grant.agent_id,
    lockWaitMs: 37.8,
    ...overrides,
  });
  const call = (
    body: unknown = createBody,
    overrides: Partial<IngressConfig> = {},
    effects: IngressEffects = {},
  ): Promise<Answer> => handleAgentEvent(sql, cfg(overrides), body, credential, null, effects);

  return {
    db,
    call,
    sql,
    cfg,
    scopes,
    stmts,
    auditAttempts: () => stmts.filter((s) => s.kind === "audit-insert"),
  };
}

const derived = (wait: number) => Math.max(1, Math.floor(wait));

function expectBoundedBefore(
  scope: Scope | null | undefined,
  wait: number,
  workKinds: string[],
  label: string,
): void {
  expect(scope, `SCOPE_MISSING: ${label} must run in its own transaction`).toBeTruthy();
  const events = scope!.events;
  const workIdx = events.findIndex((e) => workKinds.includes(e.kind));
  expect(workIdx, `WORK_MISSING: ${label} work statement not observed`).toBeGreaterThanOrEqual(0);
  const stmtIdx = events.findIndex(
    (e) => e.kind === "setting" && e.text === `SET LOCAL statement_timeout = '${derived(wait)}ms'`,
  );
  expect(
    stmtIdx,
    `STMT_TIMEOUT_MISSING: ${label} must SET LOCAL statement_timeout = '${derived(wait)}ms'`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    stmtIdx,
    `STMT_TIMEOUT_ORDER: ${label} statement_timeout must precede its work`,
  ).toBeLessThan(workIdx);
  const lockIdx = events.findIndex(
    (e) => e.kind === "setting" && e.text === `SET LOCAL lock_timeout = '${derived(wait)}ms'`,
  );
  expect(
    lockIdx,
    `LOCK_TIMEOUT_MISSING: ${label} must keep SET LOCAL lock_timeout = '${derived(wait)}ms'`,
  ).toBeGreaterThanOrEqual(0);
  expect(lockIdx, `LOCK_TIMEOUT_ORDER: ${label} lock_timeout must precede its work`).toBeLessThan(
    workIdx,
  );
}

function expectBusyEnvelope(answer: Answer): void {
  expect(answer.status, "expected the operation_busy 503").toBe(503);
  expect(answer.body).toMatchObject({
    code: "operation_busy",
    reason: "operation_busy",
    next: "Retry with the same idempotency key.",
  });
  expect(answer.body.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(answer.headers ?? {}).not.toHaveProperty("Retry-After");
  expect(JSON.stringify(answer)).not.toMatch(/private synthetic|55P03|57014|Drizzle|PostgresError/);
}

const deepBody = () => {
  const body: Record<string, unknown> = {
    op: "create",
    idempotency_key: "statement-timeout-deep-001",
  };
  let cur = body;
  for (let i = 0; i < 500; i++) {
    const nxt: Record<string, unknown> = {};
    cur.nest = nxt;
    cur = nxt;
  }
  return body;
};

describe("agent-events statement-timeout review follow-up", () => {
  it("busy classifier reads structured codes through a bounded cause chain", () => {
    expect(isIngressBusy(Object.assign(new Error("x"), { code: "57014" }))).toBe(true);
    expect(isIngressBusy(Object.assign(new Error("x"), { code: "55P03" }))).toBe(true);
    expect(isIngressBusy(wrappedCancellation("57014"))).toBe(true);
    expect(isIngressBusy(wrappedCancellation("55P03"))).toBe(true);
    expect(isIngressBusy(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isIngressBusy(wrappedCancellation("23505"))).toBe(false);
    expect(isIngressBusy(new Error("plain"))).toBe(false);
    expect(isIngressBusy(null)).toBe(false);
    expect(isIngressBusy({ code: "57014" })).toBe(true);
    // Cyclic causes terminate instead of hanging the ingress.
    const cyclic = Object.assign(new Error("cycle"), { code: "nope" }) as Error & {
      cause: unknown;
    };
    cyclic.cause = cyclic;
    expect(isIngressBusy(cyclic)).toBe(false);
    const cyclicBusy = Object.assign(new Error("cycle"), {}) as Error & { cause: unknown };
    cyclicBusy.cause = cyclicBusy;
    (cyclicBusy as unknown as { code: string }).code = "57014";
    expect(isIngressBusy(cyclicBusy)).toBe(true);
  });

  it.each(["57014", "55P03"])(
    "wrapped cancellation on the operation path yields the audited 503 (%s)",
    async (code) => {
      const f = await fixture({ site: "operation-work", error: wrappedCancellation(code) });
      const answer = await f.call();
      expectBusyEnvelope(answer);
      expect(f.db.audits).toEqual([
        {
          grantId: grant.id,
          operation: "create",
          requestId: answer.body.request_id,
          result: "error",
          reason: "operation_busy",
        },
      ]);
    },
  );

  it("deleting the grant before a cancelled replay keeps the 503 and nulls the receipt grant", async () => {
    const f = await fixture(
      { site: "replay-lookup", error: Object.assign(new Error("cancelled"), { code: "57014" }) },
      true,
    );
    const answer = await f.call();
    expectBusyEnvelope(answer);
    // The stale grant id never reaches the receipt: the busy audit observed the
    // deletion and attributed null instead of raising 23503.
    expect(f.db.audits).toEqual([
      {
        grantId: null,
        operation: "create",
        requestId: answer.body.request_id,
        result: "error",
        reason: "operation_busy",
      },
    ]);
  });

  it("busy audit attributes a vanished grant as null without masking other errors", async () => {
    const db = makeFakeAgentDb();
    // Grant never provisioned: the liveness check observes the absence.
    const outcome = await auditOperationBusy(
      db.sql,
      37.8,
      { ...grant, id: "grant-never-provisioned" },
      "create",
      null,
      "busy-vanished-key",
      "0".repeat(64),
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(outcome).toBe("audited");
    expect(db.audits).toEqual([
      {
        grantId: null,
        operation: "create",
        requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        result: "error",
        reason: "operation_busy",
      },
    ]);
  });

  it("deep-payload denial audit cancellation yields the busy 503 from a bounded transaction", async () => {
    const f = await fixture({
      site: "deny-deep-audit",
      error: Object.assign(new Error("private synthetic statement exception"), { code: "57014" }),
    });
    const answer = await f.call(deepBody());
    expectBusyEnvelope(answer);
    const attempts = f.auditAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.values[7]).toBe("payload_too_deep");
    expectBoundedBefore(attempts[0]!.scope, 37.8, ["audit-insert"], "deep-payload deny audit");
    expect(attempts[0]!.scope!.locks).toEqual([]);
    expect(attempts[1]!.values[5]).toBe(attempts[0]!.values[5]);
    expect(answer.body.request_id).toBe(attempts[0]!.values[5]);
    expect(f.db.audits).toEqual([
      {
        grantId: grant.id,
        operation: "unknown",
        requestId: answer.body.request_id,
        result: "error",
        reason: "operation_busy",
      },
    ]);
  });

  it("deep-payload happy denial stays a bounded 422 (reversion control)", async () => {
    const f = await fixture();
    const answer = await f.call(deepBody());
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ code: "payload_too_deep", reason: "payload_too_deep" });
    const attempt = f.auditAttempts().find((a) => a.values[7] === "payload_too_deep");
    expect(attempt).toBeTruthy();
    expectBoundedBefore(attempt!.scope, 37.8, ["audit-insert"], "deep-payload deny audit");
    expect(f.db.audits).toEqual([
      {
        grantId: grant.id,
        operation: "unknown",
        requestId: answer.body.request_id,
        result: "denied",
        reason: "payload_too_deep",
      },
    ]);
  });

  it("spent-budget denial audit cancellation yields the busy 503 from a bounded transaction", async () => {
    const f = await fixture({
      site: "deny-rate-audit",
      error: Object.assign(new Error("private synthetic statement exception"), { code: "57014" }),
    });
    f.db.prespend(`mutating:${grant.id}`);
    const answer = await f.call();
    expectBusyEnvelope(answer);
    const attempts = f.auditAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.values[6]).toBe("denied");
    expect(attempts[0]!.values[7]).toBe("rate_limited");
    expectBoundedBefore(attempts[0]!.scope, 37.8, ["audit-insert"], "rate_limited deny audit");
    expect(attempts[0]!.scope!.locks).toEqual([]);
    expect(attempts[1]!.values[5]).toBe(attempts[0]!.values[5]);
    expect(answer.body.request_id).toBe(attempts[0]!.values[5]);
    expect(f.db.audits).toEqual([
      {
        grantId: grant.id,
        operation: "create",
        requestId: answer.body.request_id,
        result: "error",
        reason: "operation_busy",
      },
    ]);
  });

  it("spent budget stays a bounded 429 with Retry-After (writable control)", async () => {
    const f = await fixture();
    f.db.prespend(`mutating:${grant.id}`);
    const answer = await f.call();
    expect(answer.status).toBe(429);
    expect(answer.body).toMatchObject({ code: "rate_limited", reason: "rate_limited" });
    expect(answer.headers).toMatchObject({ "Retry-After": expect.any(String) });
    const attempt = f.auditAttempts().find((a) => a.values[7] === "rate_limited");
    expect(attempt).toBeTruthy();
    expectBoundedBefore(attempt!.scope, 37.8, ["audit-insert"], "rate_limited deny audit");
    expect(f.db.audits).toEqual([
      {
        grantId: grant.id,
        operation: "create",
        requestId: answer.body.request_id,
        result: "denied",
        reason: "rate_limited",
      },
    ]);
  });
});
