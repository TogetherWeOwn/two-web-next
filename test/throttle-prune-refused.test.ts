// Acceptance: a refused join-throttle request must still prune expired
// throttle counters. The allow path already deletes rows older than the
// retention window (see throttle-prune.test.ts); a bucket under sustained
// refused load must drain the same way instead of accumulating expired rows
// until some unrelated request happens to be admitted. Pruning must never
// move a request across the admit/refuse boundary and must never record a
// hit for a refused request.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkJoinThrottle, THROTTLE_COUNTER_RETENTION_MINUTES } from "../src/join/service";
import type { Sql } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

describe("throttle-prune-refused test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "throttle prune on refused requests (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;

    const MAX = 3;
    // Older than the retention window: must be pruned by any request.
    const EXPIRED_MINUTES = THROTTLE_COUNTER_RETENTION_MINUTES + 5;
    // Outside the one-minute admission window but inside retention: must
    // neither count toward admission nor be pruned.
    const MID_MINUTES = THROTTLE_COUNTER_RETENTION_MINUTES - 3;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`delete from web_throttle_hits`;
      // Pin the prune sample so these cases exercise the refused-path prune
      // deterministically; sampling itself is pinned separately.
      vi.spyOn(Math, "random").mockReturnValue(0);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const sql = () => fixture.client as unknown as Sql;

    const seed = async (bucket: string, ageMinutes: number, count = 1) => {
      for (let i = 0; i < count; i++) {
        await fixture.client`insert into web_throttle_hits (bucket, at)
          values (${bucket}, clock_timestamp() - make_interval(mins => ${ageMinutes}))`;
      }
    };

    const rows = async () =>
      fixture.client<{ bucket: string; at_ms: number }[]>`
        select bucket, (extract(epoch from at) * 1000)::float8 as at_ms
        from web_throttle_hits order by bucket, at`;

    const countFor = async (bucket: string) =>
      (await rows()).filter((r) => r.bucket === bucket).length;

    const expiredRows = async () => {
      const floor = Date.now() - THROTTLE_COUNTER_RETENTION_MINUTES * 60_000;
      return (await rows()).filter((r) => r.at_ms <= floor);
    };

    /** Fill a bucket to its budget with fresh hits so the next check refuses. */
    const refuseBucket = async (bucket: string) => {
      await seed(bucket, 0, MAX);
      const verdict = await checkJoinThrottle(sql(), bucket, MAX);
      expect(verdict.limited).toBe(true);
      if (verdict.limited) expect(verdict.retryAfter).toBeGreaterThanOrEqual(1);
      return verdict;
    };

    it("a refused request drains expired rows from every bucket and records no new hit", async () => {
      const refused = "prune-refused-main";
      await seed(refused, EXPIRED_MINUTES, 2);
      await seed("prune-refused-stray", EXPIRED_MINUTES, 2);
      await seed("prune-refused-fresh", 0);
      await seed("prune-refused-mid", MID_MINUTES);
      expect(await expiredRows()).toHaveLength(4);

      await refuseBucket(refused);

      expect(await expiredRows()).toEqual([]);
      const seen = (await rows()).map((r) => r.bucket);
      expect(seen).toContain("prune-refused-fresh");
      expect(seen).toContain("prune-refused-mid");
      expect(seen).not.toContain("prune-refused-stray");
      // No charge on refusal: only the MAX fresh hits remain for the bucket.
      expect(await countFor(refused)).toBe(MAX);
    });

    it("sustained refused load drains accumulation instead of letting expired rows pile up", async () => {
      const refused = "prune-refused-sustained";
      await seed(refused, 0, MAX);
      for (let i = 0; i < 5; i++) await seed(`prune-refused-pile-${i}`, EXPIRED_MINUTES, 2);
      expect(await expiredRows()).toHaveLength(10);

      for (let i = 0; i < 3; i++) {
        const verdict = await checkJoinThrottle(sql(), refused, MAX);
        expect(verdict.limited).toBe(true);
      }

      expect(await expiredRows()).toEqual([]);
      expect(await countFor(refused)).toBe(MAX);
      expect(await rows()).toHaveLength(MAX);
    });

    it("pruning on a refused request frees no capacity: the next request is still refused", async () => {
      const refused = "prune-refused-boundary-full";
      await seed(refused, EXPIRED_MINUTES, 2);
      await refuseBucket(refused);

      const again = await checkJoinThrottle(sql(), refused, MAX);
      expect(again.limited).toBe(true);
      expect(await expiredRows()).toEqual([]);
      expect(await countFor(refused)).toBe(MAX);
    });

    it("a bucket one below budget is admitted when only expired or out-of-window rows would fill it", async () => {
      const bucket = "prune-refused-boundary-open";
      await seed(bucket, 0, MAX - 1);
      await seed(bucket, EXPIRED_MINUTES, 3);
      await seed(bucket, MID_MINUTES);

      const verdict = await checkJoinThrottle(sql(), bucket, MAX);

      expect(verdict).toEqual({ limited: false });
      expect(await expiredRows()).toEqual([]);
      // MAX - 1 fresh + the one hit this admission recorded + the mid row.
      expect(await countFor(bucket)).toBe(MAX + 1);
      // Having recorded that hit, the bucket is now exactly at budget.
      const next = await checkJoinThrottle(sql(), bucket, MAX);
      expect(next.limited).toBe(true);
      expect(await countFor(bucket)).toBe(MAX + 1);
    });
  },
);
