// route-inventory: POST /api/agent-events
// Acceptance contract: outer-shield 429s are audited on a bounded sample,
// never one row per refusal.
//
// The outer shield refuses over-budget hits before auth. Refusals are
// post-admission (each carries its own request_id on the 429 envelope), so
// a sampled audit gives operators traceable examples without letting a
// throttle storm grow the audit table linearly: the sampling rate is
// ~1% (SHIELD_REFUSAL_AUDIT_RATE). These pins run under a forced sampler so
// they are deterministic: shape/privacy tests stub Math.random to 0 (every
// refusal sampled, exact one row per refusal) and boundedness tests stub it
// to the rate itself (never sampled, exact zero rows). Volume itself is a
// counter signal surfaced on the sampled warn, not an audit-table signal
// (see src/agent-events/shield.ts).
//
// The contract pinned here:
// - Over a flood of outer-shield 429s with the sampler forced on, every
//   refusal writes exactly one denied/rate_limited audit row carrying its own
//   refusal's request_id (the ULID on that refusal's envelope, distinct
//   per row and from every admitted hit), result "denied" and reason_code
//   "rate_limited" — the inner refusal's existing outcome convention. The
//   row is pre-auth like the contention row: grant_id null. With the sampler
//   forced off, a flood writes exact zero rows: at most one audit insert per
//   refusal either way, never one row per refusal under live sampling.
// - A sampled row records the bucket CLASS — credential-hash vs anonymous —
//   in the existing audit columns (no migration, no new column is assumed).
//   Which existing column carries the class is the builder's choice; these
//   tests pin the observable outcome on the forced-sampled rows:
//   anonymous rows from different addresses are identical once request_id
//   is removed, credentialed and anonymous rows differ, and any
//   per-credential difference is the credential's sha256 hash and nothing
//   else. No audit value may carry the raw credential, an IP address, or
//   an IP bucket. Forcing the sample keeps these comparisons non-vacuous:
//   every flood segment contributes exactly FLOOD rows.
// - Every refused hit still writes no hit row and reaches no grant
//   lookup, and every 429 envelope still carries its request_id. The
//   contention path is unchanged (controls below).
// - Storm volume stays bounded: a single refusal costs at most one audit
//   insert, no hit insert, and a small bounded number of statements, and
//   admission for a fresh bucket still works afterwards.
//
// Hermetic and DB-free: the in-memory fake agent-event store plus an
// INSERT-recording wrapper that maps audit values to their column names,
// so no DATABASE_URL, network, or Discord access is involved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import { SHIELD_REFUSAL_AUDIT_RATE } from "../src/agent-events/shield";
import { sha256Hex } from "../src/bot/signer";
import type { Env } from "../src/env";
import app from "./app";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const cfg = (routePerMinute: number): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
  routePerMinute,
});

let n = 0;
const key = () => `shield-429-audit-${++n}`;

type AuditRow = Record<string, unknown>;

type Recording = {
  sql: FakeAgentDb["sql"];
  rows: AuditRow[];
  counts: { statements: number; hitInserts: number; auditInserts: number; grantLookups: number };
};

// Record every statement offered to the fake, mapping each audit INSERT's
// values to the column names in its own column list. Column-name mapping
// (not fixed positions) is what lets the builder choose which existing
// column carries the bucket class.
function recordingSql(fake: FakeAgentDb, opts: { failAdvisoryLock?: boolean } = {}): Recording {
  const rows: AuditRow[] = [];
  const counts = { statements: 0, hitInserts: 0, auditInserts: 0, grantLookups: 0 };
  const guard = (args: unknown[]) => {
    const strings = args[0];
    const head = Array.isArray(strings) ? ((strings[0] as string) ?? "") : "";
    counts.statements += 1;
    if (opts.failAdvisoryLock && head.includes("pg_advisory_xact_lock")) {
      throw Object.assign(new Error("lock not available (simulated contention)"), {
        code: "55P03",
      });
    }
    if (head.includes("FROM agent_event_grants WHERE verifier_hash")) counts.grantLookups += 1;
    if (head.includes("INSERT INTO agent_event_hits")) counts.hitInserts += 1;
    if (head.includes("INSERT INTO agent_event_audits")) {
      counts.auditInserts += 1;
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
      get: (t, prop) =>
        prop === "begin"
          ? (fn: (tx: unknown) => Promise<unknown>) =>
              (t as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin(
                (tx) => fn(wrap(tx)),
              )
          : Reflect.get(t, prop),
    });
  return { sql: wrap(fake.sql) as FakeAgentDb["sql"], rows, counts };
}

function setup(routePerMinute: number, opts: { failAdvisoryLock?: boolean } = {}) {
  const fake = makeFakeAgentDb();
  const rec = recordingSql(fake, opts);
  const call = (credential: string | null, ip: string | null) =>
    handleAgentEvent(
      rec.sql,
      cfg(routePerMinute),
      { op: "create", idempotency_key: key() },
      credential,
      ip,
    );
  return { fake, rec, call };
}

const shieldRows = (rec: Recording) => rec.rows.filter((r) => r.reason_code === "rate_limited");

// Forced-sampler determinism. Sampling (~1%) under live Math.random is flaky
// by construction: most floods write no rows, so privacy loops run vacuous,
// and the cap flakes the other way. Shape/privacy tests force the sample on
// (Math.random -> 0: exactly one row per refusal) and boundedness tests force
// it off (Math.random -> SHIELD_REFUSAL_AUDIT_RATE: `rate < rate` is false, so
// exact zero rows). The bound itself is the rate constant plus at-most-one
// insert per refusal, both pinned exactly below.
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Assert an exact sampled-shield row count under a forced sampler: the count
 * is exact, and every row keeps the pre-auth shape and correlates to one of
 * the refused envelopes (never to an admitted hit).
 */
function expectExactShieldRows(
  rows: AuditRow[],
  expected: number,
  envelopeIds: ReadonlySet<unknown>,
  admittedIds: ReadonlySet<unknown> = new Set(),
) {
  expect(rows).toHaveLength(expected);
  const seen = new Set<unknown>();
  for (const row of rows) {
    expect(row).toMatchObject({
      grant_id: null,
      result: "denied",
      reason_code: "rate_limited",
    });
    expect(row.request_id).toMatch(ULID);
    expect(envelopeIds.has(row.request_id)).toBe(true);
    expect(admittedIds.has(row.request_id)).toBe(false);
    expect(seen.has(row.request_id)).toBe(false);
    seen.add(row.request_id);
  }
}

const stripRequestId = (row: AuditRow): AuditRow => {
  const { request_id: _dropped, ...rest } = row;
  return rest;
};

function expectNoValueContains(rec: Recording, needles: string[]) {
  for (const row of rec.rows) {
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      for (const needle of needles) expect(value).not.toContain(needle);
    }
  }
}

describe("outer-shield 429 audit rows (sampled-bounded)", () => {
  it("a flood of anonymous over-budget refusals writes exactly one denied/rate_limited row per refusal with its own request_id", async () => {
    // Forced sample: every refusal audits, so the shape pins are exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fake, rec, call } = setup(2);
    const ip = "198.51.100.20";

    const firstAdmitted = await call(null, ip);
    expect(firstAdmitted.status).toBe(401);
    const secondAdmitted = await call(null, ip);
    expect(secondAdmitted.status).toBe(401);
    const admittedIds = new Set<unknown>([
      firstAdmitted.body.request_id,
      secondAdmitted.body.request_id,
      ...rec.rows.map((r) => r.request_id),
    ]);
    // Bucket spent. Snapshot the seams the refused hits must not touch.
    const lookupsBeforeFlood = rec.counts.grantLookups;

    const FLOOD = 20;
    const envelopeIds = new Set<unknown>();
    for (let i = 0; i < FLOOD; i++) {
      const refused = await call(null, ip);
      expect(refused.status).toBe(429);
      expect(refused.body.request_id).toMatch(ULID);
      expect(envelopeIds.has(refused.body.request_id)).toBe(false);
      envelopeIds.add(refused.body.request_id);
    }
    // Forced sample: exactly one row per refusal, each keeping the shape and
    // correlating to its refused envelope.
    expectExactShieldRows(shieldRows(rec), FLOOD, envelopeIds, admittedIds);
    // No refused hit wrote a hit row or reached a grant lookup.
    expect(fake.hits).toHaveLength(2);
    expect(rec.counts.grantLookups).toBe(lookupsBeforeFlood);
  });

  it("a flood of credentialed over-budget refusals writes exactly one row per refusal, never carrying the raw credential", async () => {
    // Forced sample: every refusal audits, so the no-credential pin is exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { rec, call } = setup(2);
    const credential = "shield-audit-credential-alpha";

    expect((await call(credential, "198.51.100.21")).status).toBe(401);
    expect((await call(credential, "198.51.100.21")).status).toBe(401);
    const lookupsBeforeFlood = rec.counts.grantLookups;

    const FLOOD = 20;
    const envelopeIds = new Set<unknown>();
    for (let i = 0; i < FLOOD; i++) {
      const refused = await call(credential, "198.51.100.21");
      expect(refused.status).toBe(429);
      expect(refused.body.request_id).toMatch(ULID);
      envelopeIds.add(refused.body.request_id);
      expect(JSON.stringify(refused.body)).not.toContain(credential);
    }
    expectExactShieldRows(shieldRows(rec), FLOOD, envelopeIds);
    expect(rec.counts.grantLookups).toBe(lookupsBeforeFlood);
    expectNoValueContains(rec, [credential]);
  });

  it("sampled rows record bucket class: anonymous rows are address-independent, credentialed rows differ only by class or credential hash", async () => {
    // Forced sample: every segment contributes exactly FLOOD rows, so the
    // class comparisons below are non-vacuous.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { rec, call } = setup(1);
    const credA = "shield-audit-credential-one";
    const credB = "shield-audit-credential-two";
    const ipA = "198.51.100.30";
    const ipB = "203.0.113.31";

    // One admission spends each bucket of 1; a flood on it is then refused.
    // Rows are attributed to a bucket by the segment they were sampled in.
    const FLOOD = 20;
    const floodBucket = async (credential: string | null, ip: string) => {
      expect((await call(credential, ip)).status).toBe(401);
      const before = shieldRows(rec).length;
      const envelopeIds = new Set<unknown>();
      for (let i = 0; i < FLOOD; i++) {
        const refused = await call(credential, ip);
        expect(refused.status).toBe(429);
        expect(refused.body.request_id).toMatch(ULID);
        envelopeIds.add(refused.body.request_id);
      }
      const segment = shieldRows(rec).slice(before);
      expectExactShieldRows(segment, FLOOD, envelopeIds);
      return segment.map(stripRequestId);
    };

    const anonA = await floodBucket(null, ipA);
    const anonB = await floodBucket(null, ipB);
    const credRowsA = await floodBucket(credA, ipA);
    const credRowsB = await floodBucket(credB, ipB);

    // Forced sample: all four floods audited every refusal.
    expect(shieldRows(rec)).toHaveLength(4 * FLOOD);
    expect(anonA).toHaveLength(FLOOD);
    expect(anonB).toHaveLength(FLOOD);

    // Same class, different addresses: identical rows. This is what proves
    // no IP bytes (raw, normalised, or bucketed) reached the audit row.
    for (const rowB of anonB) {
      for (const rowA of anonA) expect(rowB).toEqual(rowA);
    }
    // Different class: the rows must be distinguishable somewhere.
    for (const credRow of [...credRowsA, ...credRowsB]) {
      for (const anonRow of [...anonA, ...anonB]) expect(credRow).not.toEqual(anonRow);
    }
    // Two credentials: identical (pure class marker) or differing only in
    // values carrying each credential's own sha256 hash.
    const [hashA, hashB] = [await sha256Hex(credA), await sha256Hex(credB)];
    for (const credRowA of credRowsA) {
      for (const credRowB of credRowsB) {
        for (const column of Object.keys(credRowA)) {
          if (credRowA[column] === credRowB[column]) continue;
          expect(String(credRowA[column])).toContain(hashA);
          expect(String(credRowB[column])).toContain(hashB);
        }
      }
    }
    expectNoValueContains(rec, [credA, credB, ipA, ipB, "shield:ip:"]);
  });

  it("storm volume stays bounded: forced-unsampled flood writes zero rows, a forced-sampled refusal writes exactly one, admission unharmed afterwards", async () => {
    // Forced off: `rate < rate` is false, so the flood audits nothing.
    const random = vi.spyOn(Math, "random").mockReturnValue(SHIELD_REFUSAL_AUDIT_RATE);
    const { rec, call } = setup(1);
    const ip = "198.51.100.40";

    expect((await call(null, ip)).status).toBe(401);
    const lookupsBeforeStorm = rec.counts.grantLookups;
    const envelopeIds = new Set<unknown>();
    for (let i = 0; i < 25; i++) {
      const refused = await call(null, ip);
      expect(refused.status).toBe(429);
      expect(refused.body.request_id).toMatch(ULID);
      envelopeIds.add(refused.body.request_id);
    }
    // 25 refusals, sampler forced off: exact zero rows, never above any cap.
    expectExactShieldRows(shieldRows(rec), 0, envelopeIds);
    expect(rec.counts.grantLookups).toBe(lookupsBeforeStorm);

    // The 26th refusal, measured with the sampler forced on: exactly one
    // audit write (at most one per refusal either way), no hit write, no
    // grant lookup, bounded statements.
    random.mockReturnValue(0);
    const before = { ...rec.counts };
    const sampled = await call(null, ip);
    expect(sampled.status).toBe(429);
    expect(rec.counts.auditInserts - before.auditInserts).toBe(1);
    expect(rec.counts.hitInserts - before.hitInserts).toBe(0);
    expect(rec.counts.grantLookups - before.grantLookups).toBe(0);
    expect(rec.counts.statements - before.statements).toBeLessThanOrEqual(6);
    expect(shieldRows(rec)).toHaveLength(1);
    expect(shieldRows(rec)[0]!.request_id).toBe(sampled.body.request_id);

    // A fresh bucket is still admitted after the storm.
    expect((await call(null, "198.51.100.41")).status).toBe(401);
  });

  it("refusals at the mounted route audit nothing with the sampler forced off", async () => {
    // Boundedness at the route boundary: sampler forced off, exact zero rows.
    vi.spyOn(Math, "random").mockReturnValue(SHIELD_REFUSAL_AUDIT_RATE);
    const fake = makeFakeAgentDb();
    const rec = recordingSql(fake);
    const env = {
      APP_URL: "https://next.example.test",
      AGENT_EVENTS_ENABLED: "true",
      AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
      AGENT_EVENTS_ROUTE_PER_MINUTE: "1",
      AGENT_EVENT_SQL: rec.sql,
    } as unknown as Env;
    const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
    const post = () =>
      app.request(
        "/api/agent-events",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.50" },
          body: JSON.stringify({ op: "create", idempotency_key: key() }),
        },
        env,
        executionCtx,
      );

    expect((await post()).status).toBe(401);
    const FLOOD = 20;
    const envelopeIds = new Set<unknown>();
    for (let i = 0; i < FLOOD; i++) {
      const refused = await post();
      expect(refused.status).toBe(429);
      const body = (await refused.json()) as { reason: string; request_id?: unknown };
      expect(body.reason).toBe("rate_limited");
      expect(body.request_id).toMatch(ULID);
      expect(refused.headers.get("Retry-After")).toBeTruthy();
      envelopeIds.add(body.request_id);
    }
    expectExactShieldRows(shieldRows(rec), 0, envelopeIds);
    // Only the one admitted hit wrote a hit row.
    expect(fake.hits).toHaveLength(1);
  });
});

describe("outer-shield 429 audit controls", () => {
  it("control: an admitted grantless hit writes zero audit rows and no rate_limited row", async () => {
    const { fake, rec, call } = setup(60);

    const answer = await call(null, "198.51.100.60");
    expect(answer.status).toBe(401);
    expect(answer.body.reason).toBe("unauthenticated");
    expect(answer.body.request_id).toMatch(ULID);
    // Grant-first pre-auth refusal: zero audit INSERTs by contract (the
    // grantless-deep pins demand exact zero). The envelope still carries the
    // admission request_id the caller was answered with.
    expect(rec.rows).toHaveLength(0);
    expect(shieldRows(rec)).toHaveLength(0);
    expect(fake.hits.map((hit) => hit.bucket)).toEqual(["shield:ip:198.51.100.60"]);
  });

  it("control: the 429 envelope is unchanged — reason, message, retry_after mirrored in Retry-After, no stack", async () => {
    const { call } = setup(1);
    expect((await call(null, "198.51.100.61")).status).toBe(401);

    const refused = await call(null, "198.51.100.61");
    expect(refused.status).toBe(429);
    expect(refused.body.reason).toBe("rate_limited");
    expect(refused.body.message).toEqual(expect.any(String));
    expect(refused.body.retry_after).toEqual(expect.any(Number));
    expect(refused.body.retry_after as number).toBeGreaterThanOrEqual(1);
    expect(refused.headers?.["Retry-After"]).toBe(String(refused.body.retry_after));
    expect(refused.body).not.toHaveProperty("exception");
    expect(refused.body).not.toHaveProperty("trace");
    expect(refused.body).not.toHaveProperty("stack");
  });

  it("control: lock contention still answers one audited 503 operation_busy, not a 429", async () => {
    const { rec, call } = setup(60, { failAdvisoryLock: true });

    const busy = await call(null, "198.51.100.62");
    expect(busy.status).toBe(503);
    expect(busy.body.reason).toBe("operation_busy");
    expect(busy.body.request_id).toMatch(ULID);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({
      grant_id: null,
      result: "error",
      reason_code: "operation_busy",
      request_id: busy.body.request_id,
    });
    expect(shieldRows(rec)).toHaveLength(0);
  });

  it("control: a neighbouring bucket is still admitted while the spent bucket refuses", async () => {
    const { fake, call } = setup(1);

    expect((await call(null, "2001:db8:abcd:1234::1")).status).toBe(401);
    expect((await call(null, "2001:db8:abcd:1234::2")).status).toBe(429);
    expect((await call(null, "2001:db8:abcd:1235::1")).status).toBe(401);
    expect(fake.hits.at(-1)?.bucket).toBe("shield:ip:2001:db8:abcd:1235::/64");
  });
});
