// Acceptance oracle: the scheduled web_sessions expiry sweep is bounded like
// every other model:prune adapter. Each statement deletes at most
// PRUNE_DELETE_BATCH_SIZE rows, one scheduled pass drains at most
// PRUNE_DELETE_MAX_BATCHES batches and pages once via
// scheduled.failing@model:prune when the ceiling stops it, and the next
// pass drains the remainder. Removing the SQL bound (one statement deletes
// the whole backlog) or restoring the unbounded single-call sweep in the
// scheduled pass (no drain loop, no session cap page) must fail this file.
//
// Memory fakes always run; live round-trips use a guarded disposable schema
// on agent-testdb or the explicitly allowed GitHub CI Postgres service.
import { describe, expect, it, vi } from "vitest";
import { PRUNE_DELETE_BATCH_SIZE, PRUNE_DELETE_MAX_BATCHES } from "../src/jobs/constants";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import type { PruneStores } from "../src/jobs/types";
import { createJobsFixture } from "./helpers/jobs-db";

type SeedRow = { tokenHash: string; expiresAt: number };

/**
 * Injected SessionSweeper seam modelling a per-statement-bounded adapter:
 * one call deletes at most PRUNE_DELETE_BATCH_SIZE eligible rows
 * (expires_at <= now, the sweep's read-visibility contract).
 */
function boundedSessionSweeper(seed: SeedRow[]) {
  const rows = [...seed];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    remaining: () => rows.map((r) => r.tokenHash),
    async sweepExpired(now: Date): Promise<number> {
      calls++;
      let n = 0;
      for (let i = rows.length - 1; i >= 0 && n < PRUNE_DELETE_BATCH_SIZE; i--) {
        if (rows[i]!.expiresAt <= now.getTime()) {
          rows.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}

function emptyAgeTables(): Omit<PruneStores, "sessions"> {
  const empty = {
    async pruneOlderThan(_cutoff: Date): Promise<number> {
      return 0;
    },
  };
  return {
    agentEventAudits: empty,
    accessLog: empty,
    joinAttempts: empty,
    idempotencyKeys: empty,
    searchLog: empty,
    boardViews: empty,
  };
}

function expiredSeed(prefix: string, count: number, expiresAt: number): SeedRow[] {
  return Array.from({ length: count }, (_, i) => ({
    tokenHash: `${prefix}-${i + 1}`,
    expiresAt,
  }));
}

describe("scheduled session sweep bound (fake store seam, no DB)", () => {
  it("one pass drains a multi-batch expired backlog and reports the exact total", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const sessions = boundedSessionSweeper([
        ...expiredSeed("rawhash-old", PRUNE_DELETE_BATCH_SIZE + 3, now.getTime() - 60_000),
        { tokenHash: "rawhash-edge", expiresAt: now.getTime() },
        { tokenHash: "rawhash-live", expiresAt: now.getTime() + 3600_000 },
      ]);
      const counts = await pruneModelTables({ ...emptyAgeTables(), sessions }, now);
      // 1,003 expired + the exact-expiry row; only the live row survives.
      expect(counts.sessions).toBe(PRUNE_DELETE_BATCH_SIZE + 4);
      // The pass repeated the bounded statement until a short batch.
      expect(sessions.calls).toBe(2);
      expect(sessions.remaining()).toEqual(["rawhash-live"]);
      expect(warn).not.toHaveBeenCalled();
      // Logs carry counts only: no raw session material ever appears.
      const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
      expect(logged).not.toContain("rawhash-");
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("stops at the per-pass batch ceiling, pages the session cap, next pass drains", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const perPassCap = PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES;
      const sessions = boundedSessionSweeper([
        ...expiredSeed("rawhash-cap", perPassCap + 3, now.getTime() - 60_000),
        { tokenHash: "rawhash-live", expiresAt: now.getTime() + 3600_000 },
      ]);
      const stores = { ...emptyAgeTables(), sessions };

      const first = await pruneModelTables(stores, now);
      expect(first.sessions).toBe(perPassCap);
      expect(sessions.calls).toBe(PRUNE_DELETE_MAX_BATCHES);
      // The capped pass pages once for the whole pass instead of warning.
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      const raw = error.mock.calls[0]![0];
      expect(typeof raw).toBe("string");
      const line = JSON.parse(raw as string) as Record<string, unknown>;
      expect(line).toMatchObject({
        level: "critical",
        event: "scheduled.failing",
        job: "model:prune",
      });
      expect(line.error_class).toBe(line.exception);
      // The page line carries no session material or table detail.
      expect(JSON.stringify(error.mock.calls)).not.toContain("rawhash-");
      expect(raw as string).not.toContain("sessions");
      // The 3-row remainder and the live row are still there.
      expect(sessions.remaining()).toHaveLength(4);
      expect(sessions.remaining()).toContain("rawhash-live");

      const second = await pruneModelTables(stores, now);
      expect(second.sessions).toBe(3);
      expect(sessions.calls).toBe(PRUNE_DELETE_MAX_BATCHES + 1);
      // The uncapped drain stays silent: still exactly the first pass's page.
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(sessions.remaining()).toEqual(["rawhash-live"]);
      expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("rawhash-");

      expect((await pruneModelTables(stores, now)).sessions).toBe(0);
      expect(sessions.remaining()).toEqual(["rawhash-live"]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("scheduled session sweep bound (test Postgres)", () => {
  it("each scheduled-adapter statement is batch-bounded with exact survivors", async () => {
    const iso = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(iso.client as unknown as Parameters<typeof migrate>[0]);
      const psql = iso.client;
      const stores = pgPruneStores(psql);
      const now = new Date();
      const expired = PRUNE_DELETE_BATCH_SIZE + 3;
      await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        select 'rawhash-old-' || g, '1', 'a', true, false, ${new Date(now.getTime() - 60_000)}
        from generate_series(1, ${expired}) g`;
      await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('rawhash-edge','2','b',true,false,${now}),
               ('rawhash-live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;

      const eligibleLeft = async () =>
        (
          await psql<{ n: number }[]>`select count(*)::int as n from web_sessions
            where token_hash like 'rawhash-old-%' or token_hash = 'rawhash-edge'`
        )[0]!.n;
      const survivors = async () =>
        (
          await psql<{ token_hash: string }[]>`select token_hash from web_sessions
            order by token_hash`
        ).map((r) => r.token_hash);

      // 1,004 eligible rows (1,003 expired + exact-expiry): one statement
      // removes exactly one batch, the next drains the remainder, a third
      // is a no-op. An unbounded statement returns 1,004 on the first call.
      expect(await stores.sessions.sweepExpired(now)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(await eligibleLeft()).toBe(4);
      expect(await survivors()).toContain("rawhash-live");
      expect(await stores.sessions.sweepExpired(now)).toBe(4);
      expect(await eligibleLeft()).toBe(0);
      expect(await stores.sessions.sweepExpired(now)).toBe(0);
      // Exact survivors: the live control only; exact-expiry is swept
      // (reads require expires_at > now, so it is already invisible).
      expect(await survivors()).toEqual(["rawhash-live"]);
    } finally {
      await iso.dispose();
    }
  });

  it("one scheduled pass drains a multi-batch session backlog and re-runs clean", async () => {
    const iso = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { migrate } = await import("../src/sessions");
      await migrate(iso.client as unknown as Parameters<typeof migrate>[0]);
      const psql = iso.client;
      const now = new Date();
      const expired = PRUNE_DELETE_BATCH_SIZE + 3;
      await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        select 'rawhash-pass-' || g, '1', 'a', true, false, ${new Date(now.getTime() - 60_000)}
        from generate_series(1, ${expired}) g`;
      await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('rawhash-pass-live','3','c',true,false,${new Date(now.getTime() + 3600_000)})`;

      const first = await pruneModelTables(pgPruneStores(psql), now);
      expect(first.sessions).toBe(expired);
      expect(warn).not.toHaveBeenCalled();
      expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("rawhash-");
      const survivors = (
        await psql<
          { token_hash: string }[]
        >`select token_hash from web_sessions order by token_hash`
      ).map((r) => r.token_hash);
      expect(survivors).toEqual(["rawhash-pass-live"]);
      expect((await pruneModelTables(pgPruneStores(psql), now)).sessions).toBe(0);
    } finally {
      warn.mockRestore();
      info.mockRestore();
      await iso.dispose();
    }
  });
});
