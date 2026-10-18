// Acceptance: the join-throttle prune must be batch-bounded on every
// request. checkJoinThrottle deletes expired web_throttle_hits rows on both
// the admitted and the refused path; with a large expired backlog (5,000
// rows here) a single request must delete at most one bounded batch (1,000
// rows, the repository's established cleanup batch) instead of sweeping the
// whole table inside one request's transaction. The cap must not move a
// request across the admit/refuse boundary: leftover expired rows free no
// capacity, a refused request still records no hit, and an admitted request
// still records exactly one. A backlog below the batch size must still
// drain completely in one request (controls). Live against agent-testdb
// (skipped without DATABASE_URL, like test/throttle-prune.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkJoinThrottle, THROTTLE_COUNTER_RETENTION_MINUTES } from "../src/join/service";
import type { Sql } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// The pinned per-request deletion bound and the backlog that dwarfs it.
const BATCH = 1000;
const BACKLOG = 5000;
const MAX = 3;
// Older than the retention window: eligible for pruning by any request.
const EXPIRED_MINUTES = THROTTLE_COUNTER_RETENTION_MINUTES + 5;

describe("join-throttle-prune-batch test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("join throttle prune batch (agent-testdb)", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const sql = () => fixture.client as unknown as Sql;

  const seedExpired = async (bucket: string, n: number) => {
    await fixture.client`insert into web_throttle_hits (bucket, at)
      select ${bucket}, clock_timestamp() - make_interval(mins => ${EXPIRED_MINUTES})
      from generate_series(1, ${n})`;
  };
  const seedFresh = async (bucket: string, n: number) => {
    await fixture.client`insert into web_throttle_hits (bucket, at)
      select ${bucket}, clock_timestamp() from generate_series(1, ${n})`;
  };
  const countBucket = async (bucket: string): Promise<number> => {
    const [r] =
      (await fixture.client`select count(*)::int as n from web_throttle_hits where bucket = ${bucket}`) as unknown as [
        { n: number },
      ];
    return r!.n;
  };

  it("one refused request deletes at most one bounded batch of a 5k expired backlog", async () => {
    const refused = "join-batch-refused";
    await seedExpired("join-batch-backlog", BACKLOG);
    await seedFresh("join-batch-bystander", 2);
    await seedFresh(refused, MAX);

    const verdict = await checkJoinThrottle(sql(), refused, MAX);

    // The cap must not change the verdict, and refusal records no hit.
    expect(verdict.limited).toBe(true);
    if (verdict.limited) expect(verdict.retryAfter).toBeGreaterThanOrEqual(1);
    expect(await countBucket(refused)).toBe(MAX);
    // Fresh rows are never cleanup targets.
    expect(await countBucket("join-batch-bystander")).toBe(2);
    // Bounded progress: some expired rows went, at most one batch of them.
    const afterFirst = await countBucket("join-batch-backlog");
    expect(BACKLOG - afterFirst).toBeGreaterThan(0);
    expect(BACKLOG - afterFirst).toBeLessThanOrEqual(BATCH);

    // The bound is per request, not one-shot: a second refused request
    // deletes another bounded chunk and is still refused, because the
    // leftover expired rows freed no capacity.
    const again = await checkJoinThrottle(sql(), refused, MAX);
    expect(again.limited).toBe(true);
    expect(await countBucket(refused)).toBe(MAX);
    const afterSecond = await countBucket("join-batch-backlog");
    expect(afterFirst - afterSecond).toBeGreaterThan(0);
    expect(afterFirst - afterSecond).toBeLessThanOrEqual(BATCH);
  });

  it("one admitted request deletes at most one bounded batch of a 5k expired backlog", async () => {
    const bucket = "join-batch-admitted";
    await seedExpired("join-batch-backlog", BACKLOG);
    await seedFresh("join-batch-bystander", 2);

    const verdict = await checkJoinThrottle(sql(), bucket, MAX);

    // Admission is unaffected by the backlog, and charges exactly one hit.
    expect(verdict).toEqual({ limited: false });
    expect(await countBucket(bucket)).toBe(1);
    expect(await countBucket("join-batch-bystander")).toBe(2);
    const afterFirst = await countBucket("join-batch-backlog");
    expect(BACKLOG - afterFirst).toBeGreaterThan(0);
    expect(BACKLOG - afterFirst).toBeLessThanOrEqual(BATCH);

    // Leftover expired rows neither block nor unblock anyone: the bucket
    // still has fresh budget, so the next request admits and prunes
    // another bounded chunk.
    const again = await checkJoinThrottle(sql(), bucket, MAX);
    expect(again).toEqual({ limited: false });
    expect(await countBucket(bucket)).toBe(2);
    const afterSecond = await countBucket("join-batch-backlog");
    expect(afterFirst - afterSecond).toBeGreaterThan(0);
    expect(afterFirst - afterSecond).toBeLessThanOrEqual(BATCH);
  });

  it("control: a refused request drains a below-batch backlog completely and stays refused", async () => {
    const refused = "join-batch-control-refused";
    await seedExpired("join-batch-backlog-small", 40);
    await seedFresh(refused, MAX);

    const verdict = await checkJoinThrottle(sql(), refused, MAX);

    expect(verdict.limited).toBe(true);
    expect(await countBucket("join-batch-backlog-small")).toBe(0);
    expect(await countBucket(refused)).toBe(MAX);
  });

  it("control: a bucket one below budget admits and drains a below-batch backlog completely", async () => {
    const bucket = "join-batch-control-admitted";
    await seedExpired("join-batch-backlog-small", 40);
    await seedFresh(bucket, MAX - 1);

    const verdict = await checkJoinThrottle(sql(), bucket, MAX);

    expect(verdict).toEqual({ limited: false });
    expect(await countBucket("join-batch-backlog-small")).toBe(0);
    // MAX - 1 fresh + the one hit this admission recorded.
    expect(await countBucket(bucket)).toBe(MAX);
    // Now exactly at budget: the next request refuses and records nothing.
    const next = await checkJoinThrottle(sql(), bucket, MAX);
    expect(next.limited).toBe(true);
    expect(await countBucket(bucket)).toBe(MAX);
  });
});
