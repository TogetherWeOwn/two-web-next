/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkJoinThrottle, migrateJoin, type ThrottleVerdict } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Acceptance: the web-throttle admission lock wait is bounded.
//
// `checkJoinThrottle` takes `pg_advisory_xact_lock(web-throttle:<bucket>)`
// before counting. While another connection holds that exact advisory lock,
// a call for the held bucket must settle — while the holder remains locked —
// within a generous 4s bound instead of waiting for the holder. On main
// today there is no bound, so the busy cases below time out at that bound.
//
// Busy mapping (pinned here, from the human-throttle domain contract, not
// the agent-events ingress): fail-open allow, `{ limited: false }`, with no
// hit inserted. `ThrottleVerdict` has only admit/refuse shapes; a missing
// store already degrades to allow, and every generic caller already maps a
// store failure to allow ("a missed count beats a 500"). The join funnel
// calls this function with no catch of its own, so the mapping must live
// inside `checkJoinThrottle`: a lock-timeout error (55P03) must never
// propagate to a caller, never become a refusal ({ limited: true }) and
// never charge the bucket. The bound's mechanism and exact value are not
// pinned — any bound that resolves well inside 4s passes; an unbounded or
// multi-second wait does not.
//
// Prune stays outside the admission lock on every path, busy included: an
// expired row seeded in another bucket is deleted by a busy pass while the
// holder remains locked (the agent-events inner limiter prunes on its busy
// pass the same way), and by ordinary admitted/refused passes as today.
//
// Lock acquisition is coordinated explicitly: the holder's advisory-lock
// query resolving inside its open transaction on a second connection is
// the handshake that the lock is held; the measured call races a 4s bound
// only so an unbounded wait fails fast instead of hanging the suite. No
// timing-only sleep proves anything here. Every busy assertion runs while
// the holder remains locked: releasing first could let a hung request
// complete and mask it.
//
// Live against the guarded test database in a throwaway schema. Skipped
// when DATABASE_URL is unset. Never point this at production or staging.

const BUSY_BOUND_MS = 4000;

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

  // Race the measured call against a generous bound. The bound is not the
  // proof — the lock handshake is — it only turns an unbounded wait into a
  // readable failure instead of a hung suite.
  async function settleWithinBound(
    pending: Promise<ThrottleVerdict>,
    bucket: string,
  ): Promise<ThrottleVerdict> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `web-throttle lock wait on ${bucket} was not bounded: ` +
                    `call still blocked after ${BUSY_BOUND_MS}ms ` +
                    `while the advisory lock holder remains locked`,
                ),
              ),
            BUSY_BOUND_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      const start = Date.now();
      const verdict = await settleWithinBound(
        checkJoinThrottle(sql, "busy-control:independent", 10),
        "busy-control:independent",
      );
      expect(Date.now() - start).toBeLessThan(BUSY_BOUND_MS);
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
    "settles fail-open within the bound while the bucket lock is held: %s",
    async (bucket) => {
      expect(await hitsFor(bucket)).toBe(0);
      const release = await holdBucketLock(bucket);
      let pending: Promise<ThrottleVerdict> | undefined;
      try {
        const start = Date.now();
        pending = checkJoinThrottle(sql, bucket, 10);
        const busy = await settleWithinBound(pending, bucket);
        const elapsed = Date.now() - start;

        // Every assertion below runs while the holder remains locked.
        expect(elapsed).toBeLessThan(BUSY_BOUND_MS);
        // Fail-open allow: never a refusal, never a thrown lock error.
        expect(busy).toEqual({ limited: false });
        // The busy pass is free: it charges no hit to the held bucket.
        expect(await hitsFor(bucket)).toBe(0);
      } finally {
        await release();
        // Let a still-blocked call settle after release so no work dangles
        // into the next test (on the unbounded path it now completes and
        // charges its hit; beforeEach clears it).
        await pending?.catch(() => null);
      }

      // After release, normal admission resumes and charges.
      expect(await checkJoinThrottle(sql, bucket, 10)).toEqual({ limited: false });
      expect(await hitsFor(bucket)).toBeGreaterThanOrEqual(1);
    },
  );

  it("a busy pass spends no budget: the full budget is still there after release", async () => {
    const bucket = "busy-budget:one";
    const release = await holdBucketLock(bucket);
    let pending: Promise<ThrottleVerdict> | undefined;
    try {
      pending = checkJoinThrottle(sql, bucket, 1);
      const busy = await settleWithinBound(pending, bucket);
      expect(busy).toEqual({ limited: false });
      expect(await hitsFor(bucket)).toBe(0);
    } finally {
      await release();
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
    const release = await holdBucketLock(bucket);
    let pending: Promise<ThrottleVerdict> | undefined;
    try {
      pending = checkJoinThrottle(sql, bucket, 10);
      const busy = await settleWithinBound(pending, bucket);

      // All while the holder remains locked: prune never waits on, and
      // never prolongs, the held admission lock.
      expect(busy).toEqual({ limited: false });
      expect(await hitsFor("busy-prune:expired")).toBe(0);
      expect(await hitsFor("busy-prune:live")).toBe(1);
      expect(await hitsFor(bucket)).toBe(0);
    } finally {
      await release();
      await pending?.catch(() => null);
    }
  });
});
