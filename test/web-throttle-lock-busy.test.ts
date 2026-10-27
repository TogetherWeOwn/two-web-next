/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkJoinThrottle,
  migrateJoin,
  WEB_THROTTLE_LOCK_TIMEOUT_MS,
  type ThrottleVerdict,
} from "../src/join/service";
import type { Sql } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Acceptance: the web-throttle admission lock wait is bounded.
//
// `checkJoinThrottle` takes `pg_advisory_xact_lock(web-throttle:<bucket>)`
// before counting. While another connection holds that exact advisory lock,
// a call for the held bucket must settle — while the holder remains locked —
// via the `WEB_THROTTLE_LOCK_TIMEOUT_MS` database lock_timeout instead of
// waiting for the holder.
//
// Busy mapping (pinned here, from the human-throttle domain contract, not
// the agent-events ingress): refuse `{ limited: true, retryAfter: 1 }` (the
// shared 429), with no hit charged. Every bucket is per client, so
// contention on a bucket's lock is that client's own burst — a fail-open
// allow on lock-timeout would let a same-client burst bypass the throttle.
// `ThrottleVerdict` has only admit/refuse shapes; a missing store still
// degrades to allow, but a contended lock is not a missing store. The join
// funnel calls this function with no catch of its own, so the mapping must
// live inside `checkJoinThrottle`: a lock-timeout error (55P03) must never
// propagate to a caller and never charge the bucket. The bound's magnitude is
// pinned twice, both without reading the JavaScript clock: the containment
// suite pins WEB_THROTTLE_LOCK_TIMEOUT_MS to 2000, and every busy case holds
// its lock on a database-side self-release schedule (pg_sleep(5) inside the
// holder transaction, then ROLLBACK). A wait honoring the 2s lock_timeout
// refuses long before the 5s release; a wait that ignored it (say 20s) would
// still be blocked at 5s, see the release, and be admitted instead of
// refused, failing the verdict assert. An unbounded wait hangs past the
// vitest test timeout instead of answering refusal.
//
// Prune stays outside the admission lock on every path, busy included: an
// expired row seeded in another bucket is deleted by a busy pass while the
// holder remains locked (the agent-events inner limiter prunes on its busy
// pass the same way), and by ordinary admitted/refused passes as today.
//
// Lock acquisition is coordinated explicitly: the holder's advisory-lock
// query resolving inside its open transaction on a second connection is
// the handshake that the lock is held. The holder then sleeps on the
// database clock (pg_sleep, still inside its transaction so the lock stays
// held) and releases itself; the measured call is awaited directly with no
// JavaScript timer — arrival of the refusal verdict before that self-release
// IS the proof the 2s database lock_timeout fired. No wall-clock race, no
// fake timers, no timing-only sleep proves anything here. Every busy
// assertion runs before the self-release resolves: releasing first could let
// a hung request complete and mask it.
//
// Live against the guarded test database in a throwaway schema. Skipped
// when DATABASE_URL is unset. Never point this at production or staging.

describe("web-throttle lock-busy test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });

  it("control: a missing store still degrades to allow", async () => {
    expect(await checkJoinThrottle(null, "join:missing-store", 10)).toEqual({ limited: false });
  });

  it("pins the admission-lock timeout magnitude the busy proofs rely on", () => {
    // Mirrors test/performance-budgets-snapshot.test.ts: the busy cases'
    // database-side self-release (5s) only discriminates a 2s wait from a
    // 20s one while this stays 2000.
    expect(WEB_THROTTLE_LOCK_TIMEOUT_MS).toBe(2000);
  });
});

const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("web-throttle lock waits are busy-bounded (test database)", () => {
  const schemaName = `throttlebusy_${randomUUID().replaceAll("-", "")}`;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let sql: Sql;
  let created = false;

  beforeAll(async () => {
    const url = testDatabaseUrl(raw!);
    const options = {
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      onnotice: () => {},
    };
    admin = postgres(url.href, { ...options, max: 1 });
    client = postgres(url.href, {
      ...options,
      max: 8,
      connection: { search_path: schemaName },
    });
    sql = client as unknown as Sql;
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await migrateJoin(sql);
  });

  beforeEach(async () => {
    await client`DELETE FROM web_throttle_hits`;
    // Pin the prune sample so the control case exercises the prune
    // deterministically; sampling itself is pinned separately.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await client?.end({ timeout: 1 });
      if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await admin?.end({ timeout: 1 });
    }
  });

  const hitsFor = async (bucket: string) => {
    const [row] = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM web_throttle_hits WHERE bucket = ${bucket}`;
    return row!.n;
  };

  // Hold `web-throttle:<bucket>` on a second connection until the returned
  // release runs. Resolves only once the lock is actually held.
  async function holdBucketLock(bucket: string) {
    const url = testDatabaseUrl(raw!);
    const holder = postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: schemaName },
      onnotice: () => {},
    });
    await holder.unsafe("BEGIN");
    await holder`SELECT pg_advisory_xact_lock(hashtextextended(${"web-throttle:" + bucket}, 0))`;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await holder.unsafe("ROLLBACK");
      await holder.end({ timeout: 1 });
    };
  }

  // Hold `web-throttle:<bucket>` on a database-side self-release schedule.
  // The await resolves only once the lock is actually held; the returned
  // `done` promise resolves once the holder has slept `delaySecs` on the
  // database clock (inside its open transaction, so the lock stays held
  // throughout) and rolled back. The handle is a plain object (not a nested
  // promise) because await flattens Promise<Promise<T>> and would wait out
  // the whole self-release instead of just the handshake. A measured wait
  // honoring the 2s lock_timeout settles before that release; a wait
  // ignoring it is still blocked at release time, sees the lock free, and
  // is admitted instead of refused.
  async function holdBucketLockDbDelayed(
    bucket: string,
    delaySecs: number,
  ): Promise<{ done: Promise<void> }> {
    const url = testDatabaseUrl(raw!);
    const holder = postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: schemaName },
      onnotice: () => {},
    });
    await holder.unsafe("BEGIN");
    await holder`SELECT pg_advisory_xact_lock(hashtextextended(${"web-throttle:" + bucket}, 0))`;
    const done = (async () => {
      try {
        await holder.unsafe(`SELECT pg_sleep(${delaySecs})`);
      } finally {
        try {
          await holder.unsafe("ROLLBACK");
        } catch {
          // Already closed; the lock is gone either way.
        }
        await holder.end({ timeout: 1 }).catch(() => {});
      }
    })();
    return { done };
  }

  it("control: an uncontended call admits and charges exactly one hit", async () => {
    const bucket = "busy-control:admit";
    expect(await checkJoinThrottle(sql, bucket, 10)).toEqual({ limited: false });
    expect(await hitsFor(bucket)).toBe(1);
  });

  it("control: an uncontended over-budget call refuses with Retry-After and charges nothing", async () => {
    const bucket = "busy-control:refuse";
    expect(await checkJoinThrottle(sql, bucket, 1)).toEqual({ limited: false });
    const refused = await checkJoinThrottle(sql, bucket, 1);
    expect(refused.limited).toBe(true);
    if (refused.limited) {
      expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfter).toBeLessThanOrEqual(60);
    }
    expect(await hitsFor(bucket)).toBe(1);
  });

  it("control: an ordinary pass prunes expired rows outside the admission lock", async () => {
    await client`INSERT INTO web_throttle_hits (bucket, at) VALUES
      ('busy-control:expired', clock_timestamp() - interval '6 minutes'),
      ('busy-control:live', clock_timestamp() - interval '30 seconds')`;
    expect(await checkJoinThrottle(sql, "busy-control:pruner", 10)).toEqual({ limited: false });
    expect(await hitsFor("busy-control:expired")).toBe(0);
    expect(await hitsFor("busy-control:live")).toBe(1);
  });

  it("control: an independent bucket admits while another bucket's lock is held", async () => {
    const held = "busy-control:held";
    const release = await holdBucketLock(held);
    try {
      const verdict = await checkJoinThrottle(sql, "busy-control:independent", 10);
      expect(verdict).toEqual({ limited: false });
      expect(await hitsFor("busy-control:independent")).toBe(1);
      expect(await hitsFor(held)).toBe(0);
    } finally {
      await release();
    }
  });

  // Both surfaces share this one function: the join funnel's per-client
  // bucket and a generic human-route throttle bucket.
  const busyBuckets = ["join:203.0.113.7", "logout:198.51.100.9"] as const;

  it.each(busyBuckets)(
    "refuses within the bound while the bucket lock is held: %s",
    async (bucket) => {
      expect(await hitsFor(bucket)).toBe(0);
      const { done: holderDone } = await holdBucketLockDbDelayed(bucket, 5);
      let pending: Promise<ThrottleVerdict> | undefined;
      try {
        pending = checkJoinThrottle(sql, bucket, 10);
        // Direct await: the 2s database lock_timeout settles this before the
        // holder's 5s database-side self-release. Arrival of the refusal
        // before that release IS the magnitude proof: a wait ignoring the
        // 2s bound would still be blocked at 5s and be admitted instead.
        const busy = await pending;

        // Every assertion below runs before the self-release resolves.
        // Refusal (the shared 429): never an allow, never a thrown lock error.
        expect(busy).toEqual({ limited: true, retryAfter: 1 });
        // The busy pass is free: it charges no hit to the held bucket.
        expect(await hitsFor(bucket)).toBe(0);
      } finally {
        // Wait out the holder's database-side schedule so no work dangles
        // into the next test, then settle any still-blocked call (on the
        // unbounded path it now completes and charges its hit; beforeEach
        // clears it).
        await holderDone;
        await pending?.catch(() => null);
      }

      // After release, normal admission resumes and charges.
      expect(await checkJoinThrottle(sql, bucket, 10)).toEqual({ limited: false });
      expect(await hitsFor(bucket)).toBeGreaterThanOrEqual(1);
    },
  );

  it("a busy pass spends no budget: the full budget is still there after release", async () => {
    const bucket = "busy-budget:one";
    const { done: holderDone } = await holdBucketLockDbDelayed(bucket, 5);
    let pending: Promise<ThrottleVerdict> | undefined;
    try {
      pending = checkJoinThrottle(sql, bucket, 1);
      // Refusal before the holder's 5s self-release proves the 2s bound;
      // an over-long wait would be admitted instead (see above).
      const busy = await pending;
      expect(busy).toEqual({ limited: true, retryAfter: 1 });
      expect(await hitsFor(bucket)).toBe(0);
    } finally {
      await holderDone;
      await pending?.catch(() => null);
    }
    // Discard any hit a still-blocked call charged once released (the
    // unbounded path); the budget assertions below measure only post-busy
    // admission behaviour once the fix is in.
    await client`DELETE FROM web_throttle_hits WHERE bucket = ${bucket}`;
    expect(await checkJoinThrottle(sql, bucket, 1)).toEqual({ limited: false });
    const refused = await checkJoinThrottle(sql, bucket, 1);
    expect(refused.limited).toBe(true);
    expect(await hitsFor(bucket)).toBe(1);
  });

  it("a busy pass still prunes expired rows while the holder remains locked", async () => {
    const bucket = "busy-prune:held";
    await client`INSERT INTO web_throttle_hits (bucket, at) VALUES
      ('busy-prune:expired', clock_timestamp() - interval '6 minutes'),
      ('busy-prune:live', clock_timestamp() - interval '30 seconds')`;
    const { done: holderDone } = await holdBucketLockDbDelayed(bucket, 5);
    let pending: Promise<ThrottleVerdict> | undefined;
    try {
      pending = checkJoinThrottle(sql, bucket, 10);
      // Refusal before the holder's 5s self-release proves the 2s bound;
      // an over-long wait would be admitted instead (see above).
      const busy = await pending;

      // All before the self-release resolves: prune never waits on, and
      // never prolongs, the held admission lock.
      expect(busy).toEqual({ limited: true, retryAfter: 1 });
      expect(await hitsFor("busy-prune:expired")).toBe(0);
      expect(await hitsFor("busy-prune:live")).toBe(1);
      expect(await hitsFor(bucket)).toBe(0);
    } finally {
      await holderDone;
      await pending?.catch(() => null);
    }
  });
});
