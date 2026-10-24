// Bounded outer-shield refusal audit regressions.
//
// The merged 429-audit path awaits a plain INSERT outside the bucket lock, so a
// stalled audit (row lock or slow execution) stalls the refusal indefinitely.
// These owned regressions pin the bounded write: the refusal audit runs in its
// own transaction with lock + statement timeouts derived from cfg.lockWaitMs,
// a timed-out audit answers retryable 503 operation_busy with the same
// request_id, and unrelated errors still throw.
//
// The refusal audit is sampled (~1%): every test below forces the sample so
// the bounded-write assertions stay deterministic (see the beforeEach). Flood
// boundedness itself is pinned by the sampled-acceptance suites, not here.
//
// Hermetic and DB-free: in-memory fake agent-event store plus an
// INSERT-recording wrapper. Never edit
// test/agent-events-shield-429-audit-acceptance.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import {
  __resetShieldRefusalCountersForTests,
  SHIELD_REFUSAL_AUDIT_RATE,
  shieldRefusalCounters,
} from "../src/agent-events/shield";
import { sha256Hex } from "../src/bot/signer";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const cfg = (routePerMinute: number, lockWaitMs = 50): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs,
  routePerMinute,
});

let n = 0;
const key = () => `shield-bounded-audit-${++n}`;

type AuditRow = Record<string, unknown>;

type BoundedRecording = {
  sql: FakeAgentDb["sql"];
  rows: AuditRow[];
  unsafeStatements: string[];
  counts: { statements: number; advisoryLocks: number; hitInserts: number; auditInserts: number };
};

function boundedSql(
  fake: FakeAgentDb,
  opts: { failAdvisoryLock?: boolean; failAuditCode?: string; failAuditOnce?: boolean } = {},
): BoundedRecording {
  const rows: AuditRow[] = [];
  const unsafeStatements: string[] = [];
  const counts = { statements: 0, advisoryLocks: 0, hitInserts: 0, auditInserts: 0 };
  let auditFailuresLeft = opts.failAuditCode
    ? opts.failAuditOnce === false
      ? Number.MAX_SAFE_INTEGER
      : 1
    : 0;
  const guard = (args: unknown[]) => {
    const strings = args[0];
    const head = Array.isArray(strings) ? ((strings[0] as string) ?? "") : "";
    counts.statements += 1;
    if (head.includes("pg_advisory_xact_lock")) {
      counts.advisoryLocks += 1;
      if (opts.failAdvisoryLock) {
        throw Object.assign(new Error("lock not available (simulated contention)"), {
          code: "55P03",
        });
      }
    }
    if (head.includes("INSERT INTO agent_event_hits")) counts.hitInserts += 1;
    if (head.includes("INSERT INTO agent_event_audits")) {
      counts.auditInserts += 1;
      // Fail only the shield refusal audit so admission setup still commits.
      const operation = args[2] as string | null;
      if (
        auditFailuresLeft > 0 &&
        typeof operation === "string" &&
        operation.startsWith("shield:")
      ) {
        auditFailuresLeft -= 1;
        throw Object.assign(new Error(`audit stalled (simulated ${opts.failAuditCode})`), {
          code: opts.failAuditCode,
        });
      }
      const columns = (head.match(/\(([^)]*)\)/)?.[1] ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      const row: AuditRow = {};
      columns.forEach((column, i) => {
        row[column] = args[i + 1] ?? null;
      });
      rows.push(row);
    }
  };
  const wrap = (target: unknown): unknown =>
    new Proxy(target as object, {
      apply: async (t, thisArg, args: unknown[]) => {
        guard(args);
        return Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      },
      get: (t, prop) => {
        if (prop === "begin") {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            (t as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin(
              (tx) => fn(wrap(tx)),
            );
        }
        if (prop === "unsafe") {
          return async (...unsafeArgs: unknown[]) => {
            unsafeStatements.push(String(unsafeArgs[0] ?? ""));
            return Reflect.apply(
              (t as { unsafe: (...a: unknown[]) => unknown }).unsafe,
              t,
              unsafeArgs,
            );
          };
        }
        return Reflect.get(t, prop);
      },
    });
  return { sql: wrap(fake.sql) as FakeAgentDb["sql"], rows, unsafeStatements, counts };
}

function setup(
  routePerMinute: number,
  opts: { failAdvisoryLock?: boolean; failAuditCode?: string; lockWaitMs?: number } = {},
) {
  const fake = makeFakeAgentDb();
  const rec = boundedSql(fake, opts);
  const call = (credential: string | null, ip: string | null) =>
    handleAgentEvent(
      rec.sql,
      cfg(routePerMinute, opts.lockWaitMs ?? 50),
      { op: "create", idempotency_key: key() },
      credential,
      ip,
    );
  return { fake, rec, call };
}

const shieldRows = (rec: BoundedRecording) =>
  rec.rows.filter((r) => r.reason_code === "rate_limited");

// The shield refusal audit is sampled (~1%, see src/agent-events/shield.ts).
// Force the sample in every case so the bounded-write pins below stay
// deterministic; the sampling bound itself is pinned by the acceptance
// suites, not here.
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  __resetShieldRefusalCountersForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bounded outer-shield refusal audit", () => {
  it("stalled lock on the sampled refusal audit answers 503 operation_busy with the same request_id instead of stalling", async () => {
    const { fake, rec, call } = setup(1, { failAuditCode: "55P03" });
    const ip = "198.51.100.70";

    expect((await call(null, ip)).status).toBe(401);

    const refused = await call(null, ip);
    expect(refused.status).toBe(503);
    expect(refused.body.reason).toBe("operation_busy");
    expect(refused.body.request_id).toMatch(ULID);
    // No denied/rate_limited row: the timed-out audit committed nothing, and
    // the sampled refusal is a retryable 503 rather than stalling.
    expect(shieldRows(rec)).toHaveLength(0);
    // The refused hit still writes no hit row.
    expect(fake.hits).toHaveLength(1);
  });

  it("stalled statement execution on the refusal audit answers the same retryable 503", async () => {
    const { fake, rec, call } = setup(1, { failAuditCode: "57014" });
    const ip = "198.51.100.71";

    expect((await call(null, ip)).status).toBe(401);

    const refused = await call(null, ip);
    expect(refused.status).toBe(503);
    expect(refused.body.reason).toBe("operation_busy");
    expect(refused.body.request_id).toMatch(ULID);
    expect(shieldRows(rec)).toHaveLength(0);
    expect(fake.hits).toHaveLength(1);
  });

  it("unrelated audit errors still throw instead of masking as 503", async () => {
    const { call } = setup(1, { failAuditCode: "23505" });
    const ip = "198.51.100.72";

    expect((await call(null, ip)).status).toBe(401);
    await expect(call(null, ip)).rejects.toMatchObject({ code: "23505" });
  });

  it("a normal refusal still commits one denied/rate_limited row with its admission request_id", async () => {
    const { fake, rec, call } = setup(1);
    const ip = "198.51.100.73";

    expect((await call(null, ip)).status).toBe(401);
    const refused = await call(null, ip);
    expect(refused.status).toBe(429);
    expect(refused.body.reason).toBe("rate_limited");
    expect(shieldRows(rec)).toHaveLength(1);
    expect(shieldRows(rec)[0]).toMatchObject({
      grant_id: null,
      result: "denied",
      reason_code: "rate_limited",
    });
    expect(shieldRows(rec)[0]!.request_id).toBe(refused.body.request_id);
    expect(fake.hits).toHaveLength(1);
    // Credentialed refusals keep the privacy-safe class: hash, never raw bytes.
    const credential = "shield-bounded-credential-alpha";
    const { rec: rec2, call: call2 } = setup(1);
    expect((await call2(credential, ip)).status).toBe(401);
    const credRefused = await call2(credential, ip);
    expect(credRefused.status).toBe(429);
    const credRows = rec2.rows.filter((r) => r.reason_code === "rate_limited");
    expect(credRows).toHaveLength(1);
    expect(Object.values(credRows[0]!).join("\n")).toContain(await sha256Hex(credential));
    expect(Object.values(credRows[0]!).join("\n")).not.toContain(credential);
  });

  it("refusal counters increment on every refusal and each refusal warns with class + outcome", async () => {
    // The counters are the volume signal for the ~99% of refusals that write
    // no audit row: deleting the increment must fail this pin. The warn is
    // token-bucketed, not sampled: every refusal warns (or sheds) regardless
    // of the audit sampler below.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { rec, call } = setup(1);
      const ip = "198.51.100.77";

      // Admitted (grantless 401) hits are not shield refusals: no count.
      // Sampler forced off for the admission so its own pre-auth warn does
      // not pollute the shield-warn pins below.
      vi.mocked(Math.random).mockReturnValue(SHIELD_REFUSAL_AUDIT_RATE);
      expect((await call(null, ip)).status).toBe(401);
      expect(shieldRefusalCounters).toEqual({ credential: 0, anonymous: 0 });
      expect(warn).not.toHaveBeenCalled();

      // Sampler forced on for the refusals: three refusals, three rows,
      // three warns carrying the bucket class + outcome, no identity.
      vi.mocked(Math.random).mockReturnValue(0);
      for (let expected = 1; expected <= 3; expected++) {
        const refused = await call(null, ip);
        expect(refused.status).toBe(429);
        expect(shieldRefusalCounters.anonymous).toBe(expected);
        expect(shieldRefusalCounters.credential).toBe(0);
        expect(warn).toHaveBeenCalledTimes(expected);
        expect(warn.mock.calls[expected - 1]?.[0]).toBe("agent-events.shield.refused");
        expect(warn.mock.calls[expected - 1]).toEqual([
          "agent-events.shield.refused",
          { bucket_class: "anonymous", outcome: "rate_limited" },
        ]);
      }
      expect(shieldRows(rec)).toHaveLength(3);

      // Sampler forced off: two more refusals still count and still warn,
      // but write no row. The count is the only durable volume signal left.
      vi.mocked(Math.random).mockReturnValue(SHIELD_REFUSAL_AUDIT_RATE);
      expect((await call(null, ip)).status).toBe(429);
      expect((await call(null, ip)).status).toBe(429);
      expect(shieldRefusalCounters.anonymous).toBe(5);
      expect(warn).toHaveBeenCalledTimes(5);
      expect(warn.mock.calls[3]).toEqual([
        "agent-events.shield.refused",
        { bucket_class: "anonymous", outcome: "rate_limited" },
      ]);
      expect(warn.mock.calls[4]).toEqual([
        "agent-events.shield.refused",
        { bucket_class: "anonymous", outcome: "rate_limited" },
      ]);
      expect(shieldRows(rec)).toHaveLength(3);

      // Credentialed refusals count under their own class. The credential
      // bucket is new, so spend it with one (unsampled, silent) admission
      // before refusing.
      vi.mocked(Math.random).mockReturnValue(SHIELD_REFUSAL_AUDIT_RATE);
      expect((await call("shield-counter-credential", ip)).status).toBe(401);
      vi.mocked(Math.random).mockReturnValue(0);
      const credRefused = await call("shield-counter-credential", ip);
      expect(credRefused.status).toBe(429);
      expect(shieldRefusalCounters).toEqual({ credential: 1, anonymous: 5 });
      expect(warn).toHaveBeenCalledTimes(6);
      expect(warn.mock.calls[5]).toEqual([
        "agent-events.shield.refused",
        { bucket_class: "credential", outcome: "rate_limited" },
      ]);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(ip);
      expect(logged).not.toContain("ip:");
      expect(logged).not.toContain("shield-counter-credential");
      expect(logged).not.toContain(await sha256Hex("shield-counter-credential"));
    } finally {
      warn.mockRestore();
    }
  });

  it("holds no new lock: one refusal costs the bucket lock only, with bounded timeouts outside it", async () => {
    const { rec, call } = setup(1, { lockWaitMs: 50 });
    const ip = "198.51.100.74";

    expect((await call(null, ip)).status).toBe(401);
    const locksBefore = rec.counts.advisoryLocks;
    const unsafeBefore = rec.unsafeStatements.length;
    expect((await call(null, ip)).status).toBe(429);

    // The bucket transaction takes its one advisory lock; the bounded audit
    // transaction takes none.
    expect(rec.counts.advisoryLocks - locksBefore).toBe(1);
    // The audit boundary sets positive lock and statement timeouts derived
    // from the admission config, still outside the bucket lock.
    const auditTimeouts = rec.unsafeStatements.slice(unsafeBefore).join("\n");
    expect(auditTimeouts).toContain("lock_timeout");
    expect(auditTimeouts).toContain("statement_timeout");
    expect(auditTimeouts).toContain("50ms");
  });

  it("controls: admit and bucket contention paths are unchanged", async () => {
    const { fake, rec, call } = setup(60);
    const admitted = await call(null, "198.51.100.75");
    expect(admitted.status).toBe(401);
    expect(admitted.body.reason).toBe("unauthenticated");
    expect(admitted.body.request_id).toMatch(ULID);
    // Grant-first pre-auth refusal: no digest, no grant lookup, zero audit
    // rows. The envelope still carries the admission request_id.
    expect(rec.rows).toHaveLength(0);
    expect(shieldRows(rec)).toHaveLength(0);
    expect(fake.hits.map((h) => h.bucket)).toEqual(["shield:ip:198.51.100.75"]);

    const { rec: busyRec, call: busyCall } = setup(60, { failAdvisoryLock: true });
    const busy = await busyCall(null, "198.51.100.76");
    expect(busy.status).toBe(503);
    expect(busy.body.reason).toBe("operation_busy");
    expect(busyRec.rows).toHaveLength(1);
    expect(busyRec.rows[0]).toMatchObject({
      grant_id: null,
      result: "error",
      reason_code: "operation_busy",
      request_id: busy.body.request_id,
    });
    expect(busyRec.rows.filter((r) => r.reason_code === "rate_limited")).toHaveLength(0);
  });
});
