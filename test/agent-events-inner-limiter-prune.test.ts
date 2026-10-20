/// <reference types="vite/client" />
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimit } from "../src/agent-events/rate-limit";
import { DEFAULT_CONFIG, type Grant, type IngressConfig } from "../src/agent-events/types";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Acceptance: the inner agent-events limiter (`rateLimit`) prunes expired
// `agent_event_hits` rows (older than 5 minutes) on every verdict — admissions
// and refusals alike — capped at 1000 rows per pass (the outer shield's
// standard), without the prune stalling admission behind the bucket advisory
// locks. A denied-only period must therefore drain the expired backlog in
// capped batches instead of leaving it until the next admitted request, and
// one pass must never delete an unbounded backlog. Throttle verdicts and
// budgets are unchanged: a refusal still inserts no hit, and the retry
// envelope keeps its shape.
//
// Live against the guarded test database in a throwaway schema. Skipped when
// DATABASE_URL is unset. Never point this at production or staging.

const CAP = 1000;

const cfg = (overrides: Partial<IngressConfig> = {}): IngressConfig => ({
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: "agent-under-test",
  lockWaitMs: 1500,
  ...overrides,
});

let grantSeq = 0;
const grant = (): Grant => ({
  id: `grant-inner-prune-${++grantSeq}`,
  agent_id: "agent-under-test",
  guild_id: DEFAULT_CONFIG.stagingGuildId,
  expires_at: null,
  disabled_at: null,
});

describe("inner-limiter prune test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("inner limiter prune (test database)", () => {
  let fixture: MemberDataFixture;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  beforeEach(async () => {
    await sql`DELETE FROM agent_event_hits`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const bucketCount = async (bucket: string) =>
    (await sql`SELECT count(*)::int AS n FROM agent_event_hits WHERE bucket = ${bucket}`)[0]!
      .n as number;
  const expiredCount = async () =>
    (
      await sql`SELECT count(*)::int AS n FROM agent_event_hits WHERE at < now() - interval '5 minutes'`
    )[0]!.n as number;
  const seedExpired = async (bucket: string, rows: number) => {
    await sql`INSERT INTO agent_event_hits (bucket, at) SELECT ${bucket}, now() - interval '10 minutes' FROM generate_series(1, ${rows})`;
  };
  const seedHits = async (bucket: string, rows: number, age: string) => {
    await sql.unsafe(
      `INSERT INTO agent_event_hits (bucket, at) SELECT $1, now() - interval '${age}' FROM generate_series(1, $2)`,
      [bucket, rows],
    );
  };

  it("control: admits under budget, inserts one hit per bucket, prunes expired rows", async () => {
    const g = grant();
    await seedExpired("prune:stale-control", 3);
    await seedHits("prune:fresh-control", 1, "4 minutes");

    const verdict = await rateLimit(sql, cfg(), g, "read");

    expect(verdict).toBeNull();
    expect(await bucketCount(`read:${g.id}`)).toBe(1);
    expect(await bucketCount("service-read")).toBe(1);
    expect(await expiredCount()).toBe(0);
    // Rows inside the 5-minute retention window are not expired and survive.
    expect(await bucketCount("prune:fresh-control")).toBe(1);
  });

  it("control: refuses at the exact budget with the shared envelope and inserts nothing", async () => {
    const g = grant();
    const limited = cfg({ readsPerMinute: 2 });

    expect(await rateLimit(sql, limited, g, "read")).toBeNull();
    expect(await rateLimit(sql, limited, g, "read")).toBeNull();
    const refused = await rateLimit(sql, limited, g, "read");

    expect(refused?.status).toBe(429);
    expect(refused?.body.reason).toBe("rate_limited");
    expect(Number(refused?.body.retry_after)).toBeGreaterThanOrEqual(1);
    expect(Number(refused?.body.retry_after)).toBeLessThanOrEqual(60);
    expect(refused?.headers?.["Retry-After"]).toBe(String(refused?.body.retry_after));
    expect(await bucketCount(`read:${g.id}`)).toBe(2);
    expect(await bucketCount("service-read")).toBe(2);
  });

  it("control: the service bucket refuses a second grant and inserts nothing", async () => {
    const limited = cfg({ readsPerMinute: 10, serviceReadsPerMinute: 1 });
    const first = grant();
    const second = grant();

    expect(await rateLimit(sql, limited, first, "read")).toBeNull();
    const refused = await rateLimit(sql, limited, second, "read");

    expect(refused?.status).toBe(429);
    expect(refused?.body.reason).toBe("rate_limited");
    expect(await bucketCount(`read:${second.id}`)).toBe(0);
    expect(await bucketCount("service-read")).toBe(1);
  });

  it("prunes expired rows on a refused call and keeps fresh rows", async () => {
    const g = grant();
    await seedExpired("prune:stale-refused", 3);
    await seedHits("prune:fresh-refused", 1, "4 minutes");
    // Spend the read budget so the measured call is refused.
    await seedHits(`read:${g.id}`, 2, "10 seconds");

    const refused = await rateLimit(sql, cfg({ readsPerMinute: 2 }), g, "read");

    expect(refused?.status).toBe(429);
    expect(refused?.body.reason).toBe("rate_limited");
    // The refusal itself is the prune pass: expired rows drain even though
    // no request was admitted.
    expect(await expiredCount()).toBe(0);
    expect(await bucketCount("prune:fresh-refused")).toBe(1);
    // Still no charge on refusal.
    expect(await bucketCount(`read:${g.id}`)).toBe(2);
    expect(await bucketCount("service-read")).toBe(0);
  });

  it("drains an expired backlog over refused-only calls, capped at 1000 per pass", async () => {
    const g = grant();
    await seedExpired("prune:backlog-refused", CAP + 5);
    await seedHits(`read:${g.id}`, 2, "10 seconds");
    const limited = cfg({ readsPerMinute: 2 });

    const first = await rateLimit(sql, limited, g, "read");
    expect(first?.status).toBe(429);
    // Exactly one capped batch: an uncapped prune would leave 0 here, a
    // refuse-skipping prune would leave the full backlog.
    expect(await expiredCount()).toBe(5);

    const second = await rateLimit(sql, limited, g, "read");
    expect(second?.status).toBe(429);
    expect(await expiredCount()).toBe(0);
    expect(await bucketCount(`read:${g.id}`)).toBe(2);
    expect(await bucketCount("service-read")).toBe(0);
  });

  it("caps the admitted call's prune at 1000 rows per pass", async () => {
    const g = grant();
    await seedExpired("prune:backlog-admitted", CAP + 5);

    const verdict = await rateLimit(sql, cfg(), g, "read");

    expect(verdict).toBeNull();
    expect(await bucketCount(`read:${g.id}`)).toBe(1);
    expect(await bucketCount("service-read")).toBe(1);
    expect(await expiredCount()).toBe(5);
  });

  it("does not stall admission on an unrelated locked expired row", async () => {
    const g = grant();
    await seedExpired("prune:stale-free", 2);
    const lockedId = (
      await sql`INSERT INTO agent_event_hits (bucket, at) VALUES ('prune:stale-locked', now() - interval '10 minutes') RETURNING id`
    )[0]!.id as number;

    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    const holder = postgres(url.href, {
      max: 1,
      port: 5432,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let call: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      await holder`SELECT id FROM agent_event_hits WHERE id = ${lockedId} FOR UPDATE`;

      call = rateLimit(sql, cfg(), g, "read");
      const settled = await Promise.race([
        call.then(() => "call" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 2500);
        }),
      ]);
      // No SKIP LOCKED on this table: lock_timeout defers the entire batch,
      // including the two unlocked rows. Admission already committed.
      expect(settled).toBe("call");
      expect(await call).toBeNull();
      expect(await bucketCount(`read:${g.id}`)).toBe(1);
      expect(await bucketCount("service-read")).toBe(1);
      expect(await bucketCount("prune:stale-free")).toBe(2);
      expect(await bucketCount("prune:stale-locked")).toBe(1);
    } finally {
      if (timer) clearTimeout(timer);
      await holder.unsafe("ROLLBACK");
      await holder.end();
      // Let a blocked call settle after the lock release so no work dangles.
      await call?.catch(() => null);
    }
    // Recovery is a real later admission pass, not a test-side DELETE.
    expect(await rateLimit(sql, cfg(), g, "read")).toBeNull();
    expect(await expiredCount()).toBe(0);
    expect(await bucketCount(`read:${g.id}`)).toBe(2);
    expect(await bucketCount("service-read")).toBe(2);
  });
});
