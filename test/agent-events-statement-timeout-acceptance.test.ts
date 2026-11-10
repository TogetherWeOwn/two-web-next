// Test-author owned acceptance: executing statements in agent-event ingress
// must be time-bounded like lock waits already are. Today only
// `lock_timeout` is installed in the shield, inner rate-limit and operation
// transactions, so a statement that stalls while *executing* (not waiting on
// a lock) can hang the ingress; and the grant lookup, pre-transaction replay
// lookup and deny-helper audit run as bare unbounded statements. The
// in-subsystem precedent for both bounds is the busy audit: a short
// transaction whose first statements are
// `SET LOCAL lock_timeout` + `SET LOCAL statement_timeout`, each derived from
// the admission's configured deadline as
// `Math.max(1, Math.floor(cfg.lockWaitMs))` milliseconds.
//
// Contract pinned here, driven only through the public `handleAgentEvent`
// against the in-memory fake (no DATABASE_URL, no Discord, no network):
// - ST-bounds: every admission transaction (shield, inner limiter,
//   operation) installs the derived `statement_timeout` before its first
//   work statement, and the grant lookup, the pre-transaction replay lookup
//   and the deny audit each run in their own short transaction with both
//   derived bounds installed before the statement they wrap.
// - ST-busy: an executing statement cancelled with 57014 at any of those
//   sites answers the existing audited retryable 503 `operation_busy`
//   envelope (same stable `request_id` on the response and the audit row,
//   same `next` action, no exception text, no `Retry-After`). The aborted
//   verdict inserts no hit rows of its own: a shield abort leaves zero hits
//   in total, and later aborts leave exactly the already-committed hits of
//   the layers before them. 55P03 at the previously mapped sites keeps its
//   exact current behaviour, and at the newly wrapped sites it maps the
//   same way (the new short transactions install a lock bound too).
// - ST-read: `statement_timeout` is per statement. It must not be turned
//   into a transaction-duration or JS deadline around dispatch: a read whose
//   bot observation await outlasts `lockWaitMs` still succeeds, and no
//   `idle_in_transaction_session_timeout` / `transaction_timeout` is set.
// - Unexpected (non-timeout) errors still propagate unwrapped.
//
// Exact command: npx vitest run test/agent-events-statement-timeout-acceptance.test.ts
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
  type IngressEffects,
} from "../src/agent-events/service";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const credential = "synthetic-statement-timeout-acceptance";
const grant = {
  id: "statement-timeout-grant",
  agent_id: "statement-timeout-caller",
  guild_id: DEFAULT_CONFIG.stagingGuildId,
  expires_at: null,
  disabled_at: null,
};
const FIELDS = {
  title: "Statement timeout proof",
  game: "Chess",
  description: "Synthetic fixture event, never live.",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Fixture",
  capacity: 2,
};
const createBody = { op: "create", idempotency_key: "statement-timeout-key", fields: FIELDS };

type Scope = { id: number; settled: boolean; locks: string[]; events: Stmt[] };
type Stmt = { seq: number; scope: Scope | null; kind: string; text: string; values: unknown[] };
type Site =
  | "shield-count"
  | "grant-lookup"
  | "replay-lookup"
  | "inner-count"
  | "operation-work"
  | "deny-audit"
  | "all-audits";

const READ_EVENT_ROW = {
  event_key: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  agent_grant_id: grant.id,
  title: FIELDS.title,
  game: FIELDS.game,
  description: FIELDS.description,
  starts_at: new Date("2099-07-01T19:00:00.000Z"),
  ends_at: new Date("2099-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "Fixture",
  capacity: 2,
  status: "published",
  agent_version: 1,
  proof_marker: "agent-proof-statement-timeout",
  discord_event_id: "discord-event-statement-timeout",
};

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
  if (text.includes("select * from events where agent_grant_id")) return "owned-event-by-grant";
  if (text.includes("select * from events where event_key")) return "owned-event-by-key";
  if (text.includes("count(*)") && text.includes("from events")) return "event-count";
  if (text.includes("insert into events")) return "event-insert";
  if (text.includes("expires_at_ms")) return "grant-check";
  return "other";
}

async function fixture(inject?: { site: Site; code: string }) {
  const db = makeFakeAgentDb();
  await db.addGrant(credential, grant);
  const scopes: Scope[] = [];
  const stmts: Stmt[] = [];
  const error = inject
    ? Object.assign(new Error("private synthetic statement exception"), { code: inject.code })
    : null;
  let active = 0;
  let seq = 0;
  let consumed = false;
  let replayLookups = 0;

  const hitsSite = (kind: string, values: unknown[]): boolean => {
    if (!inject) return false;
    switch (inject.site) {
      case "shield-count":
        return kind === "hit-count" && String(values[0]).startsWith("shield:");
      case "inner-count":
        return kind === "hit-count" && !String(values[0]).startsWith("shield:");
      case "grant-lookup":
        return kind === "grant-lookup";
      case "replay-lookup":
        return kind === "replay-lookup" && replayLookups === 1;
      case "operation-work":
        return kind === "event-insert";
      case "deny-audit":
        return kind === "audit-insert" && values[6] === "denied" && values[7] === "wrong_caller";
      case "all-audits":
        return kind === "audit-insert";
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
        if (kind === "replay-lookup") replayLookups += 1;
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
        if (hitsSite(kind, values) && (inject?.site === "all-audits" || !consumed)) {
          consumed = true;
          return Promise.reject(error);
        }
        // Read-path rows the shared fake deliberately does not model.
        if (kind === "owned-event-by-grant") return Promise.resolve([READ_EVENT_ROW]);
        if (kind === "owned-event-by-key")
          return Promise.resolve(values[0] === READ_EVENT_ROW.event_key ? [READ_EVENT_ROW] : []);
        if (kind === "event-count") return Promise.resolve([{ n: 1 }]);
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
            active += 1;
            try {
              return await fn(wrap(target, tx));
            } finally {
              tx.settled = true;
              active -= 1;
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

  const auditAttempts = () => stmts.filter((s) => s.kind === "audit-insert");
  const scopeWithLock = (prefix: string) =>
    scopes.find((s) => s.locks.some((l) => l.startsWith(prefix)));
  const firstStmt = (kind: string) => stmts.find((s) => s.kind === kind);
  const hitBuckets = () => db.hits.map((h) => h.bucket).sort();

  return {
    db,
    call,
    scopes,
    stmts,
    error,
    auditAttempts,
    scopeWithLock,
    firstStmt,
    hitBuckets,
    active: () => active,
    successful: (kind: string) => stmts.filter((s) => s.kind === kind).length,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const derived = (wait: number) => Math.max(1, Math.floor(wait));

/** Both transaction-local bounds, derived from `wait`, precede the scope's first work statement. */
function expectBoundedBefore(
  scope: Scope | null | undefined,
  wait: number,
  workKinds: string[],
  label: string,
): void {
  expect(
    scope,
    `STMT_TIMEOUT_SCOPE_MISSING: ${label} must run in its own transaction`,
  ).toBeTruthy();
  const events = scope!.events;
  const workIdx = events.findIndex((e) => workKinds.includes(e.kind));
  expect(
    workIdx,
    `STMT_TIMEOUT_WORK_MISSING: ${label} work statement not observed`,
  ).toBeGreaterThanOrEqual(0);
  const stmtIdx = events.findIndex(
    (e) => e.kind === "setting" && e.text === `SET LOCAL statement_timeout = '${derived(wait)}ms'`,
  );
  expect(
    stmtIdx,
    `STMT_TIMEOUT_MISSING: ${label} must SET LOCAL statement_timeout = '${derived(wait)}ms' (derived from lockWaitMs=${wait})`,
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
    `STMT_TIMEOUT_LOCK_MISSING: ${label} must keep SET LOCAL lock_timeout = '${derived(wait)}ms'`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    lockIdx,
    `STMT_TIMEOUT_LOCK_ORDER: ${label} lock_timeout must precede its work`,
  ).toBeLessThan(workIdx);
}

function expectBusyEnvelope(answer: Answer): void {
  expect(answer.status, "STMT_57014_NOT_MAPPED: preserve the operation_busy 503").toBe(503);
  expect(answer.body).toMatchObject({
    code: "operation_busy",
    reason: "operation_busy",
    next: "Retry with the same idempotency key.",
  });
  expect(answer.body.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(answer.headers ?? {}).not.toHaveProperty("Retry-After");
  expect(JSON.stringify(answer)).not.toMatch(
    /private synthetic|55P03|57014|exception|stack|statement_timeout|lock_timeout/,
  );
}

function expectSingleBusyAudit(
  f: Fixture,
  answer: Answer,
  grantId: string | null,
  operation: string,
): void {
  expect(f.db.audits).toEqual([
    {
      grantId,
      operation,
      requestId: answer.body.request_id,
      result: "error",
      reason: "operation_busy",
    },
  ]);
}

const shieldScope = (f: Fixture) => f.scopeWithLock("agent-event-hits:shield:");
const innerScope = (f: Fixture) =>
  f.scopes.find((s) =>
    s.locks.some(
      (l) =>
        l.startsWith("agent-event-hits:mutating:") ||
        l.startsWith("agent-event-hits:read:") ||
        l.startsWith("agent-event-hits:service-"),
    ),
  );
const operationScope = (f: Fixture) => f.scopeWithLock("agent-event-idempotency:");
const shieldHitBuckets = (f: Fixture) => f.hitBuckets().filter((b) => b.startsWith("shield:"));

describe("agent-events statement-timeout acceptance (fake transactions)", () => {
  it.each([37.8, 81.2])(
    "ST-bounds: shield, grant, replay, inner and operation scopes install the derived statement_timeout before work (lockWaitMs=%s)",
    async (wait) => {
      const f = await fixture();
      const answer = await f.call(createBody, { lockWaitMs: wait });
      expect(answer.status).toBe(201);

      expectBoundedBefore(shieldScope(f), wait, ["lock"], "shield transaction");
      expectBoundedBefore(
        f.firstStmt("grant-lookup")?.scope,
        wait,
        ["grant-lookup"],
        "grant lookup",
      );
      expectBoundedBefore(
        f.firstStmt("replay-lookup")?.scope,
        wait,
        ["replay-lookup"],
        "pre-transaction replay lookup",
      );
      expectBoundedBefore(innerScope(f), wait, ["lock"], "inner rate-limit transaction");
      expectBoundedBefore(operationScope(f), wait, ["lock"], "operation transaction");

      // The wrapped lookups are short dedicated transactions: they take no
      // advisory locks, insert no hits, and the replay lookup's transaction
      // is opened (and settled) before the inner limiter's.
      for (const kind of ["grant-lookup", "replay-lookup"] as const) {
        const scope = f.firstStmt(kind)!.scope!;
        expect(scope.locks, `${kind} transaction must not take admission locks`).toEqual([]);
        expect(
          scope.events.filter((e) => e.kind === "hit-insert"),
          `${kind} transaction must not write hits`,
        ).toEqual([]);
      }
      expect(f.firstStmt("replay-lookup")!.scope!.id).toBeLessThan(innerScope(f)!.id);

      // No transaction-local setting is installed outside a transaction, and
      // nothing installs a transaction-duration bound.
      expect(
        f.stmts.filter((s) => s.kind === "setting" && s.scope === null && s.text.includes("LOCAL")),
      ).toEqual([]);
      expect(
        f.stmts.filter(
          (s) =>
            s.kind === "setting" &&
            /idle_in_transaction_session_timeout|transaction_timeout/.test(s.text),
        ),
      ).toEqual([]);
      expect(f.active()).toBe(0);
    },
  );

  it("ST-bounds-edge: a sub-millisecond lockWaitMs derives the 1ms floor for both bounds", async () => {
    const f = await fixture();
    const answer = await f.call(createBody, { lockWaitMs: 0.4 });
    expect(answer.status).toBe(201);
    expectBoundedBefore(shieldScope(f), 0.4, ["lock"], "shield transaction");
    expectBoundedBefore(f.firstStmt("grant-lookup")?.scope, 0.4, ["grant-lookup"], "grant lookup");
  });

  it("ST-bounds-deny: the deny audit runs in its own bounded transaction on the happy denial path", async () => {
    const f = await fixture();
    const answer = await f.call(createBody, { callerAgentId: "a-different-caller" });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "wrong_caller", reason: "wrong_caller" });
    const denyAttempt = f.auditAttempts().find((a) => a.values[7] === "wrong_caller");
    expect(denyAttempt).toBeTruthy();
    expectBoundedBefore(denyAttempt!.scope, 37.8, ["audit-insert"], "deny audit");
    expect(denyAttempt!.scope!.locks).toEqual([]);
    expect(f.db.audits).toEqual([
      {
        grantId: grant.id,
        operation: "create",
        requestId: answer.body.request_id,
        result: "denied",
        reason: "wrong_caller",
      },
    ]);
    // Refused before the replay lookup and inner limiter: only the shield hit stands.
    expect(f.hitBuckets()).toEqual(shieldHitBuckets(f));
    expect(f.hitBuckets()).toHaveLength(1);
    expect(f.active()).toBe(0);
  });

  it("ST-busy-shield: 57014 on the shield count yields the audited 503 and zero hit rows in total", async () => {
    const f = await fixture({ site: "shield-count", code: "57014" });
    const answer = await f.call();
    expectBusyEnvelope(answer);
    expectBoundedBefore(shieldScope(f), 37.8, ["lock"], "shield transaction");
    expectSingleBusyAudit(f, answer, null, "unknown");
    expect(f.db.hits).toEqual([]);
    expect(f.successful("event-insert")).toBe(0);
    expect(f.active()).toBe(0);
  });

  it.each(["57014", "55P03"])(
    "ST-busy-grant-%s: a cancelled grant lookup yields the audited 503 with no hits beyond the shield's",
    async (code) => {
      const f = await fixture({ site: "grant-lookup", code });
      const answer = await f.call();
      expectBusyEnvelope(answer);
      expectBoundedBefore(
        f.firstStmt("grant-lookup")?.scope,
        37.8,
        ["grant-lookup"],
        "grant lookup",
      );
      expectSingleBusyAudit(f, answer, null, "unknown");
      expect(f.hitBuckets()).toEqual(shieldHitBuckets(f));
      expect(f.hitBuckets()).toHaveLength(1);
      expect(f.active()).toBe(0);
    },
  );

  it.each(["57014", "55P03"])(
    "ST-busy-replay-%s: a cancelled pre-transaction replay lookup yields the grant-attributed audited 503, free of charge",
    async (code) => {
      const f = await fixture({ site: "replay-lookup", code });
      const answer = await f.call();
      expectBusyEnvelope(answer);
      expectBoundedBefore(
        f.firstStmt("replay-lookup")?.scope,
        37.8,
        ["replay-lookup"],
        "pre-transaction replay lookup",
      );
      expectSingleBusyAudit(f, answer, grant.id, "create");
      const attempt = f.auditAttempts()[0]!;
      expect(attempt.values[3]).toBe(createBody.idempotency_key);
      expect(attempt.values[4]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
      expect(f.hitBuckets()).toEqual(shieldHitBuckets(f));
      expect(f.hitBuckets()).toHaveLength(1);
      expect(f.active()).toBe(0);
    },
  );

  it.each(["57014", "55P03"])(
    "ST-busy-inner-%s: a cancelled inner count yields the audited 503 and inserts no inner hits",
    async (code) => {
      const f = await fixture({ site: "inner-count", code });
      const answer = await f.call();
      expectBusyEnvelope(answer);
      expectBoundedBefore(innerScope(f), 37.8, ["lock"], "inner rate-limit transaction");
      expectSingleBusyAudit(f, answer, grant.id, "create");
      expect(f.hitBuckets()).toEqual(shieldHitBuckets(f));
      expect(f.hitBuckets()).toHaveLength(1);
      expect(f.successful("event-insert")).toBe(0);
      expect(f.active()).toBe(0);
    },
  );

  it.each(["57014", "55P03"])(
    "ST-busy-operation-%s: a cancelled operation statement yields the audited 503 with no event or receipt stored",
    async (code) => {
      const f = await fixture({ site: "operation-work", code });
      const answer = await f.call();
      expectBusyEnvelope(answer);
      expectBoundedBefore(operationScope(f), 37.8, ["lock"], "operation transaction");
      expectSingleBusyAudit(f, answer, grant.id, "create");
      // Shield + both inner hits committed before the operation ran; the
      // aborted operation itself stored nothing.
      expect(f.hitBuckets()).toHaveLength(3);
      expect(f.successful("idem-insert")).toBe(0);
      expect(f.active()).toBe(0);
    },
  );

  it.each(["57014", "55P03"])(
    "ST-busy-deny-%s: a cancelled deny audit is reported as operation_busy under the same request_id",
    async (code) => {
      const f = await fixture({ site: "deny-audit", code });
      const answer = await f.call(createBody, { callerAgentId: "a-different-caller" });
      expectBusyEnvelope(answer);
      const attempts = f.auditAttempts();
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.values[6]).toBe("denied");
      expect(attempts[0]!.values[7]).toBe("wrong_caller");
      expectBoundedBefore(attempts[0]!.scope, 37.8, ["audit-insert"], "deny audit");
      // The busy report is a second, separate bounded audit attempt carrying
      // the very request_id the failed denial would have carried.
      expect(attempts[1]!.values[5]).toBe(attempts[0]!.values[5]);
      expect(answer.body.request_id).toBe(attempts[0]!.values[5]);
      expectSingleBusyAudit(f, answer, grant.id, "create");
      expect(f.hitBuckets()).toEqual(shieldHitBuckets(f));
      expect(f.hitBuckets()).toHaveLength(1);
      expect(f.active()).toBe(0);
    },
  );

  it("ST-busy-deny-double-timeout: when the busy report also times out, the same 503 stands unaudited", async () => {
    const f = await fixture({ site: "all-audits", code: "57014" });
    const answer = await f.call(createBody, { callerAgentId: "a-different-caller" });
    expectBusyEnvelope(answer);
    const attempts = f.auditAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.values[5]).toBe(attempts[0]!.values[5]);
    expect(answer.body.request_id).toBe(attempts[0]!.values[5]);
    expect(f.db.audits).toEqual([]);
    expect(f.hitBuckets()).toHaveLength(1);
    expect(f.active()).toBe(0);
  });

  it("ST-read: a bot observation await outlasting lockWaitMs still answers 200 inside the bounded operation transaction", async () => {
    const f = await fixture();
    let observationWaited = false;
    const readEvent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      observationWaited = true;
      return {
        ok: true as const,
        event: {
          event_id: READ_EVENT_ROW.discord_event_id,
          name: FIELDS.title,
          starts_at: "2099-07-01T19:00:00.000Z",
          location: "Fixture",
          status: "scheduled",
          observed_at: "2099-07-01T19:00:00.000Z",
        },
      };
    });
    const answer = await f.call(
      { op: "read", idempotency_key: "statement-timeout-read-key" },
      { lockWaitMs: 37.8 },
      { readEvent },
    );
    expect(answer.status).toBe(200);
    expect(readEvent).toHaveBeenCalledTimes(1);
    expect(observationWaited).toBe(true);
    expect(answer.body.discord).toMatchObject({ event_id: READ_EVENT_ROW.discord_event_id });
    // The read's own statements are bounded per statement in the operation
    // transaction; the await between them is not a statement and carries no
    // transaction-duration bound.
    expectBoundedBefore(operationScope(f), 37.8, ["lock"], "read operation transaction");
    expect(
      f.stmts.filter(
        (s) =>
          s.kind === "setting" &&
          /idle_in_transaction_session_timeout|transaction_timeout/.test(s.text),
      ),
    ).toEqual([]);
    expect(f.hitBuckets()).toHaveLength(3);
    expect(f.active()).toBe(0);
  });

  it("ST-unexpected-operation: a non-timeout operation error propagates unwrapped with no busy audit", async () => {
    const f = await fixture({ site: "operation-work", code: "23505" });
    await expect(f.call()).rejects.toBe(f.error);
    expect(f.auditAttempts().filter((a) => a.values[7] === "operation_busy")).toEqual([]);
    expect(f.active()).toBe(0);
  });

  it("ST-unexpected-grant: a non-timeout grant lookup error propagates unwrapped with no busy audit", async () => {
    const f = await fixture({ site: "grant-lookup", code: "42601" });
    await expect(f.call()).rejects.toBe(f.error);
    expect(f.auditAttempts()).toEqual([]);
    expect(f.active()).toBe(0);
  });

  it("ST-happy: the unbounded-by-default path is unchanged — a valid create stores, audits ok and charges shield plus inner hits", async () => {
    const f = await fixture();
    const answer = await f.call();
    expect(answer.status).toBe(201);
    expect(answer.body.event_key).toBeTruthy();
    expect(f.db.audits).toEqual([
      {
        grantId: grant.id,
        operation: "create",
        requestId: answer.body.request_id,
        result: "ok",
        reason: null,
      },
    ]);
    expect(f.hitBuckets()).toEqual(
      expect.arrayContaining([`mutating:${grant.id}`, "service-mutating"]),
    );
    expect(f.hitBuckets()).toHaveLength(3);
    expect(f.successful("idem-insert")).toBe(1);
    expect(f.active()).toBe(0);
  });
});
