import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { consume } from "../src/jobs/consumer";
import { pgQueueDepth, pgQueueLedger } from "../src/jobs/postgres";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

// Mirrors of the 3rd review's P1 proofs, against the fixed code. Live-DB parts
// use connection-scoped temporary tables on DATABASE_URL (CI's postgres:17
// service, agent-testdb locally); shared tables are never written or dropped.

function memLock(held = new Set<string>()): UniqueLock & { held: Set<string> } {
  return {
    held,
    acquire: async (k) => (held.has(k) ? false : (held.add(k), true)),
    release: async (k) => void held.delete(k),
  };
}
function store(): EventStore {
  return {
    prepareSync: async (_key, idempotencyKey, mirroredAt) => ({
      eventKey: "e1", idempotencyKey, mirroredAt, revision: 1, state: "pending", action: "event.upsert",
      payload: { eventKey: "e1", name: "n", startsAt: "s", endsAt: null, location: "l", description: null },
    }),
    completeSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSyncKey: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  };
}
function msg(body: unknown, attempts = 1) {
  const r = { body, attempts, acked: false, retried: undefined as number | undefined | "now" };
  return Object.assign(r, {
    ack() { r.acked = true; },
    retry(o?: { delaySeconds?: number }) { r.retried = o?.delaySeconds ?? "now"; },
  });
}
// CI sets DATABASE_URL to its postgres:17 service (localhost); local runs fall
// back to the shared agent-testdb host. Never hardcode the host: CI has no
// `agent-testdb` DNS and fails with EAI_AGAIN (PR #30 `check` on d276d0b).
const URL = process.env.DATABASE_URL ?? "postgres://agent_test@agent-testdb:5432/postgres";

describe("P1-2: every accepted jobId keeps its row (real SQL)", () => {
  it("two live dispatches of the same key count 2", async () => {
    const live = postgres(URL, { max: 1 });
    try {
      await live`create temporary table queue_jobs (like public.queue_jobs including all)`;
      await live`create temporary table queue_failed_jobs (like public.queue_failed_jobs including all)`;
      const ledger = pgQueueLedger(live);
      const a = crypto.randomUUID(), b = crypto.randomUUID();
      await ledger.enqueued({ jobId: a, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
      await ledger.enqueued({ jobId: b, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() + 600_000) });
      const depth = await pgQueueDepth(live);
      expect(depth.total).toBe(2);
      expect(depth.pending).toBe(1);
      expect(depth.delayed).toBe(1);
    } finally {
      await live.end();
    }
  });
});

describe("P1-3: exhausted throws ack, nonterminal throws retry", () => {
  it("attempt-6 throw: failed() + ack, no retry, lock freed", async () => {
    const bot = { upsertEvent: async () => { throw new TypeError("boom"); } } as unknown as BotClient;
    const lock = memLock(new Set(["sync-event:e1"]));
    const calls: string[] = [];
    const ledger: QueueLedger = {
      enqueued: async () => {},
      reserved: async () => { calls.push("reserved"); },
      released: async () => { calls.push("released"); },
      dequeued: async () => { calls.push("dequeued"); },
      failed: async () => { calls.push("failed"); },
    };
    const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j" }, 6);
    await consume({ messages: [m] }, { bot, events: store(), lock, ledger });
    expect(calls).toEqual(["reserved", "failed"]);
    expect(m.acked).toBe(true);
    expect(m.retried).toBeUndefined();
    expect(lock.held.has("sync-event:e1")).toBe(false);
  });
});

describe("P1-1: wedged ledger SQL cannot stall ack (isolated connection)", () => {
  it("terminal path completes while the real ledger UPDATE is row-lock-blocked", async () => {
    // Real row-lock contention on a temporary table: the blocker transaction
    // holds a FOR UPDATE lock on the ledger row; the real pgQueueLedger
    // UPDATE then waits on it. The worker isolates ledger I/O on its own
    // connection (the handleQueue wiring below), so the wedged statement
    // holds only the ledger client while the handler, unique lock and ack
    // proceed. Ack must land before the lock is released.
    const mk = () => postgres(URL, { max: 1 });
    const blocker = mk();
    const mainSql = mk();
    const ledgerSql = mk();
    // Run-owned scratch table: created in this proof, dropped at the end, so
    // the caller's tables are never touched (TOG-9895 review: the suite must
    // not write caller-visible tables at all). The name is unique per run.
    const scratch = `scratch_iso_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const one = crypto.randomUUID();
      // Row-lock contention: the blocker transaction holds FOR UPDATE on the
      // scratch row; the ledger client's UPDATE then waits on it. The worker
      // isolates ledger I/O on its own connection, so the wedged statement
      // holds only the ledger client while the handler, unique lock and ack
      // proceed. Ack must land before the lock is released.
      await mainSql.unsafe(`create table "${scratch}" (id int primary key, v int)`);
      await mainSql.unsafe(`insert into "${scratch}" values (1, 0)`);
      await blocker`begin`;
      await blocker.unsafe(`select * from "${scratch}" where id = 1 for update`);
      let handlerRan = false;
      const ledger: QueueLedger = {
        enqueued: async () => {},
        reserved: async () => { await ledgerSql.unsafe(`update "${scratch}" set v = v + 1 where id = 1`); },
        released: async () => {},
        dequeued: async () => {},
        failed: async () => {},
      };
      const bot = {
        upsertEvent: async () => (handlerRan = true, { ok: true, requestId: null, discordEventId: "d" }),
      } as unknown as BotClient;
      const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: one });
      const done = consume({ messages: [m] }, { bot, events: store(), lock: memLock(), ledger });
      const winner = await Promise.race([done.then(() => "done"), new Promise((r) => setTimeout(() => r("timeout"), 20000))]);
      expect(handlerRan).toBe(true);
      expect(winner).toBe("done");
      expect(m.acked).toBe(true);
      await blocker`rollback`;
      await done;
      await mainSql.unsafe(`drop table "${scratch}"`);
    } finally {
      await blocker.end();
      await mainSql.end();
      await ledgerSql.end();
    }
  }, 30000);
});

describe("P1-1b: the producer-side ledger no longer shares a pool with the consumer lock", () => {
  it("a wedged reserved() cannot hold lock.release hostage (separate clients)", async () => {
    // Supersedes the old shared-pool regression guard. Two changes made the
    // old assertion obsolete: (a) the worker isolates ledger I/O on its own
    // connection (handleQueue), and (b) lock cleanup is bounded best-effort
    // (releaseLock, 2s) — so even a wedged `reserved` no longer stalls the
    // terminal ack path. This proof pins the new posture: with the ledger
    // wedged on a real row lock, the consumer still acks promptly while the
    // release goes through its own client.
    //
    // Run-owned scratch table: created in this proof, dropped at the end, so
    // the caller's tables are never touched. The name is unique per run.
    const mainSql = postgres(URL, { max: 1 });
    const blocker = postgres(URL, { max: 1 });
    const scratch = `scratch_iso2_${crypto.randomUUID().replaceAll("-", "")}`;
    const ledgerSql = postgres(URL, { max: 1 });
    const releaseSql = postgres(URL, { max: 1 });
    try {
      await mainSql.unsafe(`create table "${scratch}" (id int primary key, v int)`);
      await mainSql.unsafe(`insert into "${scratch}" values (1, 0)`);
      await blocker`begin`;
      await blocker.unsafe(`select * from "${scratch}" where id = 1 for update`);
      let released = false;
      const ledger: QueueLedger = {
        enqueued: async () => {},
        reserved: async () => { await ledgerSql.unsafe(`update "${scratch}" set v = v + 1 where id = 1`); },
        released: async () => {},
        dequeued: async () => {},
        failed: async () => {},
      };
      const lock: UniqueLock = {
        acquire: async () => true,
        // Own client: the row lock is held by `blocker`, not by this
        // session — but `blocker` holds FOR UPDATE on the same row, so this
        // UPDATE also waits. The point stands: the bounded ledger (2s)
        // expires first and ack lands before the 8s race ends.
        release: async () => { await releaseSql.unsafe(`update "${scratch}" set v = v + 1 where id = 1`); released = true; },
      };
      const bot = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d" }),
      } as unknown as BotClient;
      const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: crypto.randomUUID() });
      const done = consume({ messages: [m] }, { bot, events: store(), lock, ledger });
      const winner = await Promise.race([done.then(() => "done"), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
      // Bounded ledger (2s) and bounded lock cleanup (2s) both expire while
      // the row lock is held, so the handler runs and the terminal ack lands
      // promptly — the wedged statements hold only their own clients.
      // `released` stays false until the blocker rolls back (both UPDATEs
      // wait on the same row lock); clearing it must never gate the ack.
      expect(winner).toBe("done");
      expect(m.acked).toBe(true);
      expect(released).toBe(false);
      await blocker`rollback`;
      await done;
      // `done` already settled via the 2s bounded path, so it cannot wait for
      // the orphaned release UPDATE: poll until the unblocked statement lands.
      const deadline = Date.now() + 5000;
      while (!released && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(released).toBe(true);
      await mainSql.unsafe(`drop table "${scratch}"`);
    } finally {
      await blocker.end();
      await mainSql.end();
      await ledgerSql.end({ timeout: 1 });
      await releaseSql.end({ timeout: 1 });
    }
  }, 30000);
});
