// Acceptance suite (Test Author owned): the daily prune drain must not treat
// a short batch as proof that a table is drained.
//
// Contract under test, at the `PruneStores` seam (`src/jobs/cron.ts`
// `drainPruneTable`, driven through `pruneModelTables`):
// - A batched delete may return fewer than PRUNE_DELETE_BATCH_SIZE rows while
//   eligible unlocked rows remain unvisited (a candidate window partially
//   consumed by rows another transaction holds `FOR UPDATE`, skipped via
//   `SKIP LOCKED`). When that happens the same pass must either keep draining
//   until those rows are gone or report `capped: true` through `reportCap`;
//   it must never finish with short totals and `capped: false`, which reads
//   as "fully drained".
// - An empty batch (0) is the drained proof. Uncontended totals, the batch
//   size, the per-pass batch ceiling, cutoff semantics and lock mode are
//   unchanged: a short batch that truly ends a table stays uncapped.
// - Positive controls below pin the uncontended and real-Postgres behaviour
//   that must not regress (on real Postgres the candidate select refills
//   past lock-held rows, so the live round trip already drains unlocked
//   rows; it must keep doing so).
//
// Hermetic tests script `AgePrunedTable`/session-sweep return sequences and
// need no database. The live round trip uses a guarded disposable schema on
// agent-testdb or the CI service only.
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  JOIN_ATTEMPT_RETENTION_DAYS,
  PRUNE_DELETE_BATCH_SIZE,
  PRUNE_DELETE_MAX_BATCHES,
} from "../src/jobs/constants";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import type { PruneStores } from "../src/jobs/types";
import type { Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const DB = process.env.DATABASE_URL;
const DAY = 86_400_000;
const NOW = new Date("2026-10-18T00:00:00Z");

const AGE_TABLES = [
  "agentEventAudits",
  "accessLog",
  "joinAttempts",
  "idempotencyKeys",
  "searchLog",
  "boardViews",
] as const;
type AgeTable = (typeof AGE_TABLES)[number];
type StoreName = AgeTable | "sessions";

/** Per-call delete-count source: call n (1-based) deletes fn(n) rows. */
type BatchSource = (call: number) => number;
const seq =
  (...batches: number[]): BatchSource =>
  (call) =>
    batches[call - 1] ?? 0;
const always =
  (n: number): BatchSource =>
  () =>
    n;

function scriptedStores(sources: Partial<Record<StoreName, BatchSource>>) {
  const calls = {} as Record<StoreName, number>;
  const run = (name: StoreName) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    return (sources[name] ?? always(0))(calls[name]);
  };
  const stores = {
    sessions: { sweepExpired: run("sessions") },
  } as unknown as PruneStores;
  for (const name of AGE_TABLES) {
    calls[name] = 0;
    (stores as unknown as Record<string, unknown>)[name] = { pruneOlderThan: run(name) };
  }
  calls.sessions = 0;
  return { stores, calls };
}

async function runPass(stores: PruneStores) {
  const reports: boolean[] = [];
  const counts = await pruneModelTables(stores, NOW, {
    reportCap: (capped) => reports.push(capped),
  });
  return { counts, reports, capped: reports[0] ?? false };
}

describe("prune drain past SKIP LOCKED short batches (hermetic stubs)", () => {
  it("a short first batch with eligible rows remaining drains them same-pass or reports capped, for every store", async () => {
    // Every age table: first candidate window returns a short 400 (the rest
    // of the window is lock-held and skipped) while 850 unlocked eligible
    // rows sit beyond it. Sessions: short 250 with 500 beyond.
    const { stores } = scriptedStores({
      agentEventAudits: seq(400, 600, 250),
      accessLog: seq(400, 600, 250),
      joinAttempts: seq(400, 600, 250),
      idempotencyKeys: seq(400, 600, 250),
      searchLog: seq(400, 600, 250),
      boardViews: seq(400, 600, 250),
      sessions: seq(250, 500),
    });
    const { counts, reports, capped } = await runPass(stores);

    expect(reports).toHaveLength(1);
    for (const name of AGE_TABLES) {
      // Never a short total presented as drained: either the pass deleted
      // all 1250 unlocked rows, or it said capped.
      expect(counts[name] === 1250 || capped, `${name} drained-or-capped`).toBe(true);
      expect(counts[name]).toBeLessThanOrEqual(1250);
    }
    expect(counts.sessions === 750 || capped, "sessions drained-or-capped").toBe(true);
    expect(counts.sessions).toBeLessThanOrEqual(750);
  });

  it("a short batch midway through a drain is not proof of drainage either", async () => {
    // One full batch, then a window almost entirely lock-held (10 deleted),
    // with 990 unlocked rows still beyond it.
    const { stores } = scriptedStores({
      joinAttempts: seq(PRUNE_DELETE_BATCH_SIZE, 10, 990),
    });
    const { counts, capped } = await runPass(stores);

    expect(counts.joinAttempts === 2000 || capped, "joinAttempts drained-or-capped").toBe(true);
    expect(counts.joinAttempts).toBeLessThanOrEqual(2000);
    for (const name of AGE_TABLES.filter((n) => n !== "joinAttempts")) {
      expect(counts[name]).toBe(0);
    }
    expect(counts.sessions).toBe(0);
  });

  it("perpetually short batches keep draining to the ceiling or report capped, never stop at the first short batch", async () => {
    // Every statement deletes half a batch and more rows always remain:
    // the pass must not mistake the first short batch for a drained table,
    // and must stay bounded (the batch ceiling, plus at most one proving
    // batch past it). Draining all the way to the ceiling satisfies the
    // continue-draining arm; stopping earlier must report capped.
    const { stores, calls } = scriptedStores({ accessLog: always(500) });
    const { counts, capped } = await runPass(stores);

    expect(
      capped || counts.accessLog >= 500 * PRUNE_DELETE_MAX_BATCHES,
      "accessLog drained-to-ceiling-or-capped",
    ).toBe(true);
    expect(calls.accessLog).toBeLessThanOrEqual(PRUNE_DELETE_MAX_BATCHES + 1);
    expect(counts.accessLog).toBe(500 * calls.accessLog);
  });

  it("positive control: uncontended multi-batch totals are unchanged and uncapped", async () => {
    const full = seq(PRUNE_DELETE_BATCH_SIZE, PRUNE_DELETE_BATCH_SIZE, 37);
    const { stores } = scriptedStores({
      agentEventAudits: full,
      accessLog: full,
      joinAttempts: full,
      idempotencyKeys: full,
      searchLog: full,
      boardViews: full,
      sessions: seq(PRUNE_DELETE_BATCH_SIZE, 5),
    });
    const { counts, reports, capped } = await runPass(stores);

    expect(reports).toEqual([false]);
    expect(capped).toBe(false);
    expect(counts).toEqual({
      agentEventAudits: 2 * PRUNE_DELETE_BATCH_SIZE + 37,
      accessLog: 2 * PRUNE_DELETE_BATCH_SIZE + 37,
      joinAttempts: 2 * PRUNE_DELETE_BATCH_SIZE + 37,
      idempotencyKeys: 2 * PRUNE_DELETE_BATCH_SIZE + 37,
      searchLog: 2 * PRUNE_DELETE_BATCH_SIZE + 37,
      boardViews: 2 * PRUNE_DELETE_BATCH_SIZE + 37,
      sessions: PRUNE_DELETE_BATCH_SIZE + 5,
      jobUniqueLocks: 0,
    });
  });

  it("positive control: a single short batch that truly drains its table stays uncapped, and a re-run is clean", async () => {
    const { stores } = scriptedStores({ joinAttempts: seq(42) });
    const first = await runPass(stores);
    expect(first.counts.joinAttempts).toBe(42);
    expect(first.capped).toBe(false);

    const second = await runPass(stores);
    expect(second.counts).toEqual({
      agentEventAudits: 0,
      accessLog: 0,
      joinAttempts: 0,
      idempotencyKeys: 0,
      searchLog: 0,
      boardViews: 0,
      sessions: 0,
      jobUniqueLocks: 0,
    });
    expect(second.capped).toBe(false);
  });
});

function schemaClient(fixture: JobsFixture, applicationName: string, max = 2) {
  const target = new URL(DB!);
  return postgres(DB!, {
    max,
    port: 5432,
    password: () => target.password,
    connection: { search_path: fixture.schemaName, application_name: applicationName },
    onnotice: () => {},
  });
}

describe.skipIf(!DB)("prune drain past a lock-held first window (test Postgres)", () => {
  it("all unlocked eligible rows drain in the same pass while the first candidate window is lock-held", async () => {
    const fixture = await createJobsFixture(DB!, { max: 4 });
    const sweeper = schemaClient(fixture, `prune_drain_${Date.now()}`, 4);
    const observer = schemaClient(fixture, "prune_drain_obs", 2);
    const locker = schemaClient(fixture, "prune_drain_hold", 1);
    const marker = `drain-${fixture.schemaName}`;
    let counts: Record<string, number> | undefined;
    let settledWhileHeld = false;
    let pass: Promise<Record<string, number>> | undefined;
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(sweeper as unknown as Sql);
      const now = new Date();
      const old = new Date(now.getTime() - (JOIN_ATTEMPT_RETENTION_DAYS + 1) * DAY);
      const edge = new Date(now.getTime() - JOIN_ATTEMPT_RETENTION_DAYS * DAY);
      const fresh = new Date(now.getTime() - DAY);
      // 2.5 batches of eligible rows. The locker will hold the first
      // candidate window (lowest PRUNE_DELETE_BATCH_SIZE ids); 1500 unlocked
      // eligible rows sit beyond it, plus cutoff-exact/fresh controls.
      await observer`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        select 'added', 'site', ${marker} || '-' || g, '10', ${old}
        from generate_series(1, ${PRUNE_DELETE_BATCH_SIZE + 1500}) as g`;
      await observer`insert into join_attempts (outcome, source, request_id, discord_id, created_at)
        values ('added','site',${marker + "-edge"},'11',${edge}),
               ('denied','site',${marker + "-fresh"},'12',${fresh})`;

      try {
        await locker.begin(async (tx) => {
          await tx`select id from join_attempts
            where request_id like ${marker + "-%"} and created_at = ${old}
            order by id limit ${PRUNE_DELETE_BATCH_SIZE} for update`;
          pass = pruneModelTables(pgPruneStores(sweeper), now, {
            reportCap: () => {},
          }) as Promise<Record<string, number>>;
          let settled = false;
          let value: Record<string, number> | undefined;
          void pass.then(
            (v) => {
              settled = true;
              value = v;
            },
            () => {
              settled = true;
            },
          );
          const deadline = Date.now() + 20_000;
          while (!settled && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
          }
          settledWhileHeld = settled;
          if (settled) counts = value;
        });
      } finally {
        await pass?.catch(() => {});
      }
      if (!settledWhileHeld) counts = (await pass!) as Record<string, number>;

      // The pass settles around the held window (SKIP LOCKED) and drains
      // every unlocked eligible row beyond it in the same pass — not just
      // the rows that fit beside the lock-held ones in one window.
      expect(settledWhileHeld).toBe(true);
      expect(counts).toMatchObject({
        agentEventAudits: 0,
        accessLog: 0,
        joinAttempts: 1500,
        idempotencyKeys: 0,
        searchLog: 0,
        boardViews: 0,
        sessions: 0,
      });
      const remaining = await observer<{ n: number }[]>`select count(*)::int as n
        from join_attempts where created_at = ${old}`;
      expect(remaining[0]!.n).toBe(PRUNE_DELETE_BATCH_SIZE);

      // After release the deferred window drains, then the pass runs clean;
      // cutoff-exact and fresh controls survive every pass.
      const second = await pruneModelTables(pgPruneStores(sweeper), now);
      expect(second.joinAttempts).toBe(PRUNE_DELETE_BATCH_SIZE);
      const third = await pruneModelTables(pgPruneStores(sweeper), now);
      expect(third.joinAttempts).toBe(0);
      const controls = await observer<{ request_id: string }[]>`select request_id
        from join_attempts where request_id in (${marker + "-edge"}, ${marker + "-fresh"})
        order by id`;
      expect(controls.map((r) => r.request_id)).toEqual([marker + "-edge", marker + "-fresh"]);
    } finally {
      await sweeper.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await locker.end({ timeout: 1 });
      await fixture.dispose();
    }
  }, 60_000);
});
