// Test-author owned. Cleanup may defer a whole batch but may never change an
// already decided admission/refusal. Exercise real transactions and lock
// handshakes, not a fake SQL driver or a timer as a proxy for admission.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { rateLimit } from "../src/agent-events/rate-limit";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import type { Grant } from "../src/agent-events/types";
import { sha256Hex } from "../src/bot/signer";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { pruneClient, within } from "./helpers/prune-contention";

const cleanupGate = vi.hoisted(() => ({ pause: undefined as undefined | (() => Promise<void>) }));
vi.mock("../src/agent-events/prune-hits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-events/prune-hits")>();
  return {
    ...actual,
    async pruneAgentEventHits(sql: postgres.Sql) {
      // Pause only at the cleanup boundary; all admission SQL and the eventual
      // cleanup are real. This lets a peer inspect locks BEFORE cleanup ends.
      await cleanupGate.pause?.();
      await actual.pruneAgentEventHits(sql);
    },
  };
});

const DB = process.env.DATABASE_URL;
const config: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: "prune-fixture",
  lockWaitMs: 50,
  readsPerMinute: 1,
  routePerMinute: 1,
};
const grant: Grant = {
  id: "prune-fixture-grant",
  agent_id: "prune-fixture",
  guild_id: DEFAULT_CONFIG.stagingGuildId,
  expires_at: null,
  disabled_at: null,
};
const token = "synthetic-prune-unknown-caller";
const cases = [
  "inner-admit",
  "inner-refuse",
  "inner-busy",
  "shield-admit",
  "shield-refuse",
] as const;
type Verdict = (typeof cases)[number];

describe.skipIf(!DB)("agent-event housekeeping contention (test Postgres, acceptance)", () => {
  let fixture: JobsFixture;
  let sql: postgres.Sql;
  let holder: postgres.Sql;
  let probe: postgres.Sql;
  let shieldBucket: string;
  beforeAll(async () => {
    fixture = await createJobsFixture(DB!, { max: 4 });
    sql = fixture.client;
    holder = pruneClient(fixture.schemaName, "hits_cleanup_holder");
    probe = pruneClient(fixture.schemaName, "hits_bucket_probe");
    shieldBucket = `shield:${await sha256Hex(token)}`;
  });
  beforeEach(async () => {
    await sql`delete from agent_event_hits`;
  });
  afterAll(async () => {
    await holder?.end({ timeout: 1 });
    await probe?.end({ timeout: 1 });
    await fixture?.dispose();
  });
  const count = async (bucket: string) =>
    (await sql`select count(*)::int as n from agent_event_hits where bucket = ${bucket}`)[0]!.n;
  async function seed() {
    await sql`insert into agent_event_hits (bucket, at)
      select 'stale', now() - interval '10 minutes' from generate_series(1,1005)`;
    await sql`insert into agent_event_hits (bucket, at)
      values ('fresh',now() - interval '4 minutes')`;
  }
  async function prepare(verdict: Verdict) {
    if (verdict === "inner-refuse") {
      await sql`insert into agent_event_hits (bucket, at) values (${`read:${grant.id}`},now())`;
    }
    if (verdict === "shield-refuse") {
      await sql`insert into agent_event_hits (bucket, at) values (${shieldBucket},now())`;
    }
    if (verdict === "inner-busy") {
      await holder`select pg_advisory_xact_lock(hashtextextended('agent-event-hits:service-read',0))`;
    }
  }
  function call(verdict: Verdict) {
    return verdict.startsWith("inner")
      ? rateLimit(sql, config, grant, "read")
      : handleAgentEvent(
          sql,
          config,
          { op: "create", idempotency_key: crypto.randomUUID() },
          token,
          null,
        );
  }
  async function assertVerdict(verdict: Verdict, answer: Awaited<ReturnType<typeof call>>) {
    if (verdict === "inner-admit") {
      expect(answer).toBeNull();
    } else {
      const expected = verdict === "inner-busy" ? 503 : verdict.endsWith("refuse") ? 429 : 401;
      expect(answer?.status).toBe(expected);
      expect(answer?.body.reason).toBe(
        expected === 503 ? "operation_busy" : expected === 429 ? "rate_limited" : "unauthenticated",
      );
      expect(answer?.body.request_id).toEqual(expect.any(String));
      expect(answer?.body).not.toHaveProperty("exception");
      expect(answer?.body).not.toHaveProperty("trace");
      expect(answer?.body).not.toHaveProperty("stack");
      if (expected === 429) {
        expect(Number(answer?.body.retry_after)).toBeGreaterThanOrEqual(1);
        expect(Number(answer?.body.retry_after)).toBeLessThanOrEqual(60);
        expect(answer?.headers?.["Retry-After"]).toBe(String(answer?.body.retry_after));
      }
    }
    await assertAdmissionCommitted(verdict);
  }
  async function assertAdmissionCommitted(verdict: Verdict) {
    expect(await count(`read:${grant.id}`)).toBe(
      verdict === "inner-admit" || verdict === "inner-refuse" ? 1 : 0,
    );
    expect(await count("service-read")).toBe(verdict === "inner-admit" ? 1 : 0);
    expect(await count(shieldBucket)).toBe(verdict.startsWith("shield") ? 1 : 0);
    // A separate backend can take the admission locks before cleanup's holder
    // releases. This catches cleanup accidentally retaining the bucket tx.
    const buckets = verdict.startsWith("shield") ? [shieldBucket] : [`read:${grant.id}`];
    if (verdict !== "inner-busy") buckets.push("service-read");
    for (const bucket of buckets) {
      await probe.begin(async (tx) => {
        const [row] =
          await tx`select pg_try_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`},0)) as free`;
        expect(row!.free, `admission lock ${bucket} still held by cleanup`).toBe(true);
      });
    }
  }

  it.each(cases)("$0 releases admission locks before entering cleanup", async (verdict) => {
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanupGate.pause = async () => {
      entered();
      await parked;
    };
    await seed();
    await holder.unsafe("BEGIN");
    let pending: ReturnType<typeof call> | undefined;
    try {
      await prepare(verdict);
      pending = call(verdict);
      await within(entry, 2500);
      // Cleanup is still parked, so checking physical committed hits and
      // peer-acquirable advisory locks here proves the transaction boundary.
      await assertAdmissionCommitted(verdict);
      expect(await count("stale")).toBe(1005);
      release();
      await assertVerdict(verdict, await within(pending, 2500));
      expect(await count("stale")).toBe(5);
    } finally {
      cleanupGate.pause = undefined;
      release();
      await holder.unsafe("ROLLBACK");
      await pending?.catch(() => {});
    }
  });

  it.each(cases)("$0 returns its verdict while cleanup single-flight is held", async (verdict) => {
    await seed();
    await holder.unsafe("BEGIN");
    let pending: ReturnType<typeof call> | undefined;
    try {
      await holder`select pg_advisory_xact_lock(hashtextextended('agent-event-hits:prune',0))`;
      await prepare(verdict);
      pending = call(verdict);
      const answer = await within(pending, 2500);
      await assertVerdict(verdict, answer);
      expect(await count("stale")).toBe(1005);
      expect(await count("fresh")).toBe(1);
    } finally {
      await holder.unsafe("ROLLBACK");
      await pending?.catch(() => {});
    }
  });

  it.each(cases)(
    "$0 preserves its verdict on a held stale row, then cleanup recovers",
    async (verdict) => {
      await seed();
      await holder.unsafe("BEGIN");
      let pending: ReturnType<typeof call> | undefined;
      try {
        await holder`select id from agent_event_hits where bucket = 'stale' order by id offset 1 limit 1 for update`;
        await prepare(verdict);
        pending = call(verdict);
        await assertVerdict(verdict, await within(pending, 2500));
        // The entire capped batch rolls back, including the free first row.
        expect(await count("stale")).toBe(1005);
        expect(await count("fresh")).toBe(1);
      } finally {
        await holder.unsafe("ROLLBACK");
        await pending?.catch(() => {});
      }
      // Refused-only inner traffic proves a real later pass drains one capped
      // batch, then the tail. Existing recent bucket charges stay untouched.
      await sql`insert into agent_event_hits (bucket, at) values ('read:denied-recovery',now())`;
      const deniedGrant = { ...grant, id: "denied-recovery" };
      expect((await rateLimit(sql, config, deniedGrant, "read"))?.status).toBe(429);
      expect(await count("stale")).toBe(5);
      expect((await rateLimit(sql, config, deniedGrant, "read"))?.status).toBe(429);
      expect(await count("stale")).toBe(0);
      expect(await count("fresh")).toBe(1);
    },
  );

  it("shield-only refusals drain capped oldest-first batches without authenticating", async () => {
    await sql`insert into agent_event_hits (bucket, at) values (${shieldBucket},now())`;
    // Insert newer expired rows first. An id-ordered regression deletes them
    // instead of the strictly older rows inserted later.
    await sql`insert into agent_event_hits (bucket, at)
      select 'newer-expired', now() - interval '6 minutes' from generate_series(1,5)`;
    await sql`insert into agent_event_hits (bucket, at)
      select 'older-expired', now() - interval '10 minutes' from generate_series(1,1000)`;
    await sql`insert into agent_event_hits (bucket, at) values ('fresh',now() - interval '4 minutes')`;
    await assertVerdict("shield-refuse", await call("shield-refuse"));
    expect(await count("older-expired")).toBe(0);
    expect(await count("newer-expired")).toBe(5);
    await assertVerdict("shield-refuse", await call("shield-refuse"));
    expect(await count("newer-expired")).toBe(0);
    expect(await count("fresh")).toBe(1);
  });

  it.each(cases)("$0 cannot be changed by a non-timeout cleanup exception", async (verdict) => {
    await seed();
    await sql.unsafe(`create function reject_hits_cleanup() returns trigger language plpgsql as $$
      begin raise exception 'synthetic cleanup failure' using errcode = '55000'; end $$`);
    await sql.unsafe(`create trigger reject_hits_cleanup before delete on agent_event_hits
      for each row execute function reject_hits_cleanup()`);
    let pending: ReturnType<typeof call> | undefined;
    await holder.unsafe("BEGIN");
    try {
      await prepare(verdict);
      pending = call(verdict);
      await assertVerdict(verdict, await within(pending, 2500));
      expect(await count("stale")).toBe(1005);
    } finally {
      await holder.unsafe("ROLLBACK");
      await pending?.catch(() => {});
      await sql.unsafe("drop trigger reject_hits_cleanup on agent_event_hits");
      await sql.unsafe("drop function reject_hits_cleanup()");
    }
  });
});
