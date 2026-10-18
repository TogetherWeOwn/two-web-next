// route-inventory: POST /api/agent-events
// Acceptance contract: audit every outer-shield 429 with its request_id.
//
// Today the outer shield refuses over-budget hits before auth and writes
// nothing for them (see the header of src/agent-events/shield.ts), while the
// inner rate limiter audits its refusal (result "denied", reason_code
// "rate_limited") and shield lock contention audits "error" /
// "operation_busy". A throttle storm against the outer shield therefore
// leaves no per-refusal record to trace.
//
// The contract pinned here:
// - Every outer-shield 429 writes exactly ONE agent_event_audits row with
//   that admission's own request_id (the ULID minted for the admission,
//   distinct per refusal and from every admitted hit), result "denied" and
//   reason_code "rate_limited" — the inner refusal's existing outcome
//   convention. The row is pre-auth like the contention row: grant_id null.
// - The row records the bucket CLASS — credential-hash vs anonymous — in
//   the existing audit columns (no migration, no new column is assumed).
//   Which existing column carries the class is the builder's choice; these
//   tests pin the observable outcome instead: anonymous refusals from
//   different addresses produce identical rows once request_id is removed,
//   credentialed and anonymous rows differ, and any per-credential
//   difference is the credential's sha256 hash and nothing else. No audit
//   value may carry the raw credential, an IP address, or an IP bucket.
// - Admit and contention paths are unchanged (controls below), the 429
//   envelope is unchanged (the audit request_id is not required to appear
//   in the response body; response shape is out of scope), and a refused
//   hit still writes no hit row.
// - Storm volume stays bounded: one refusal costs one audit insert, no
//   hit insert, and a small bounded number of statements, and admission
//   for a fresh bucket still works afterwards.
//
// Hermetic and DB-free: the in-memory fake agent-event store plus an
// INSERT-recording wrapper that maps audit values to their column names,
// so no DATABASE_URL, network, or Discord access is involved.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
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
  counts: { statements: number; hitInserts: number; auditInserts: number };
};

// Record every statement offered to the fake, mapping each audit INSERT's
// values to the column names in its own column list. Column-name mapping
// (not fixed positions) is what lets the builder choose which existing
// column carries the bucket class.
function recordingSql(fake: FakeAgentDb, opts: { failAdvisoryLock?: boolean } = {}): Recording {
  const rows: AuditRow[] = [];
  const counts = { statements: 0, hitInserts: 0, auditInserts: 0 };
  const guard = (args: unknown[]) => {
    const strings = args[0];
    const head = Array.isArray(strings) ? ((strings[0] as string) ?? "") : "";
    counts.statements += 1;
    if (opts.failAdvisoryLock && head.includes("pg_advisory_xact_lock")) {
      throw Object.assign(new Error("lock not available (simulated contention)"), {
        code: "55P03",
      });
    }
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

describe("outer-shield 429 audit rows", () => {
  it("anonymous over-budget refusals each write one denied/rate_limited row with their own request_id", async () => {
    const { fake, rec, call } = setup(2);
    const ip = "198.51.100.20";

    expect((await call(null, ip)).status).toBe(401);
    expect((await call(null, ip)).status).toBe(401);
    const admittedRequestIds = new Set(rec.rows.map((r) => r.request_id));
    expect(admittedRequestIds.size).toBe(2);

    const firstRefusal = await call(null, ip);
    expect(firstRefusal.status).toBe(429);
    expect(shieldRows(rec)).toHaveLength(1);
    expect(shieldRows(rec)[0]).toMatchObject({
      grant_id: null,
      result: "denied",
      reason_code: "rate_limited",
    });
    expect(shieldRows(rec)[0]!.request_id).toMatch(ULID);
    expect(admittedRequestIds.has(shieldRows(rec)[0]!.request_id)).toBe(false);
    // The refused hit still writes no hit row: only the two admitted hits did.
    expect(fake.hits).toHaveLength(2);

    const secondRefusal = await call(null, ip);
    expect(secondRefusal.status).toBe(429);
    expect(shieldRows(rec)).toHaveLength(2);
    expect(shieldRows(rec)[1]!.request_id).toMatch(ULID);
    expect(shieldRows(rec)[1]!.request_id).not.toBe(shieldRows(rec)[0]!.request_id);
    expect(fake.hits).toHaveLength(2);
  });

  it("credentialed over-budget refusals each write one row, never carrying the raw credential", async () => {
    const { rec, call } = setup(2);
    const credential = "shield-audit-credential-alpha";

    expect((await call(credential, "198.51.100.21")).status).toBe(401);
    expect((await call(credential, "198.51.100.21")).status).toBe(401);

    const refused = await call(credential, "198.51.100.21");
    expect(refused.status).toBe(429);
    expect(shieldRows(rec)).toHaveLength(1);
    expect(shieldRows(rec)[0]).toMatchObject({
      grant_id: null,
      result: "denied",
      reason_code: "rate_limited",
    });
    expect(shieldRows(rec)[0]!.request_id).toMatch(ULID);
    expectNoValueContains(rec, [credential]);
    expect(JSON.stringify(refused.body)).not.toContain(credential);
  });

  it("records bucket class: anonymous rows are address-independent, credentialed rows differ only by class or credential hash", async () => {
    const { rec, call } = setup(1);
    const credA = "shield-audit-credential-one";
    const credB = "shield-audit-credential-two";
    const ipA = "198.51.100.30";
    const ipB = "203.0.113.31";

    // One admission spends each bucket of 1; the next hit on it is refused.
    expect((await call(null, ipA)).status).toBe(401);
    expect((await call(null, ipA)).status).toBe(429);
    expect((await call(null, ipB)).status).toBe(401);
    expect((await call(null, ipB)).status).toBe(429);
    expect((await call(credA, ipA)).status).toBe(401);
    expect((await call(credA, ipA)).status).toBe(429);
    expect((await call(credB, ipB)).status).toBe(401);
    expect((await call(credB, ipB)).status).toBe(429);

    const rows = shieldRows(rec);
    expect(rows).toHaveLength(4);
    const [anonA, anonB, credRowA, credRowB] = rows.map(stripRequestId);

    // Same class, different addresses: identical rows. This is what proves
    // no IP bytes (raw, normalised, or bucketed) reached the audit row.
    expect(anonB).toEqual(anonA);
    // Different class: the rows must be distinguishable somewhere.
    expect(credRowA).not.toEqual(anonA);
    expect(credRowB).not.toEqual(anonA);
    // Two credentials: identical (pure class marker) or differing only in
    // values carrying each credential's own sha256 hash.
    const [hashA, hashB] = [await sha256Hex(credA), await sha256Hex(credB)];
    for (const column of Object.keys(credRowA!)) {
      if (credRowA![column] === credRowB![column]) continue;
      expect(String(credRowA![column])).toContain(hashA);
      expect(String(credRowB![column])).toContain(hashB);
    }
    expectNoValueContains(rec, [credA, credB, ipA, ipB, "shield:ip:"]);
  });

  it("storm volume stays bounded: one audit insert and no hit insert per refusal, admission unharmed afterwards", async () => {
    const { rec, call } = setup(1);
    const ip = "198.51.100.40";

    expect((await call(null, ip)).status).toBe(401);
    for (let i = 0; i < 25; i++) {
      expect((await call(null, ip)).status).toBe(429);
    }
    expect(shieldRows(rec)).toHaveLength(25);
    expect(new Set(shieldRows(rec).map((r) => r.request_id)).size).toBe(25);

    // The 26th refusal, measured: exactly one bounded audit write.
    const before = { ...rec.counts };
    expect((await call(null, ip)).status).toBe(429);
    expect(rec.counts.auditInserts - before.auditInserts).toBe(1);
    expect(rec.counts.hitInserts - before.hitInserts).toBe(0);
    expect(rec.counts.statements - before.statements).toBeLessThanOrEqual(6);

    // A fresh bucket is still admitted after the storm.
    expect((await call(null, "198.51.100.41")).status).toBe(401);
  });

  it("audits the refusal at the mounted route too", async () => {
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
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { reason: string }).reason).toBe("rate_limited");
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    expect(shieldRows(rec)).toHaveLength(1);
    expect(shieldRows(rec)[0]!.request_id).toMatch(ULID);
  });
});

describe("outer-shield 429 audit controls (already true today)", () => {
  it("control: admitted hits write their unauthenticated audit with the answer's request_id and no rate_limited row", async () => {
    const { fake, rec, call } = setup(60);

    const answer = await call(null, "198.51.100.60");
    expect(answer.status).toBe(401);
    expect(answer.body.reason).toBe("unauthenticated");
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({ reason_code: "unauthenticated" });
    // The recorded column mapping is sound: this admitted row's request_id
    // is the very id the caller was answered with.
    expect(rec.rows[0]!.request_id).toBe(answer.body.request_id);
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
