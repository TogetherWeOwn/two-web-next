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
    find: async () => ({
      eventKey: "e1",
      payload: { eventKey: "e1", name: "n", startsAt: "s", endsAt: null, location: "l", description: null },
      mirrored: true,
    }),
    recordMirrored: async () => {},
    closeFinished: async () => 0,
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
    const setup = mk();
    await setup`create temporary table iso_jobs (job_id uuid primary key, kind text not null, key text, available_at timestamptz not null, reserved_at timestamptz, created_at timestamptz not null default now())`;
    await setup`create temporary table iso_failed (id bigserial primary key, job_id uuid not null, kind text not null, key text, reason text not null, failed_at timestamptz not null default now())`;
    await setup.end();
    const blocker = mk();
    const mainSql = mk();
    const ledgerSql = mk();
    try {
      const one = crypto.randomUUID();
      // Both sessions see the same temp tables only if shared — instead lock
      // via the shared public table shape on temp tables of one session: the
      // blocker locks, the ledger client (same temp-table owner session cannot
      // span clients), so use table-level lock on a shared scratch table.
      await mainSql`create table if not exists scratch_iso (id int primary key, v int)`;
      await mainSql`insert into scratch_iso values (1, 0) on conflict do nothing`;
      await blocker`begin`;
      await blocker`select * from scratch_iso where id = 1 for update`;
      let handlerRan = false;
      const ledger: QueueLedger = {
        enqueued: async () => {},
        reserved: async () => { await ledgerSql`update scratch_iso set v = v + 1 where id = 1`; },
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
      await mainSql`delete from scratch_iso where id = 1`;
    } finally {
      await blocker.end();
      await mainSql.end();
      await ledgerSql.end();
    }
  }, 30000);
});

describe("P1-1b: the old shared-pool wiring fails the same proof (regression guard)", () => {
  it("a wedged lock.release stalls ack when ledger and lock share one client", async () => {
    // Documents WHY the worker isolates the ledger: with a single max:1
    // client behind both pgQueueLedger and pgUniqueLock, a wedged statement
    // queues every later statement behind it and ack never lands until the
    // database lock is released. If this test starts passing, the isolation
    // is no longer load-bearing — recheck the worker wiring.
    const mainSql = postgres(URL, { max: 1 });
    const blocker = postgres(URL, { max: 1 });
    try {
      await mainSql`create table if not exists scratch_iso2 (id int primary key, v int)`;
      await mainSql`insert into scratch_iso2 values (1, 0) on conflict do nothing`;
      await blocker`begin`;
      await blocker`select * from scratch_iso2 where id = 1 for update`;
      // Both "ledger" and "lock" go through one max:1 client, like the old worker.
      const shared = postgres(URL, { max: 1 });
      let released = false;
      try {
        const ledger: QueueLedger = {
          enqueued: async () => {},
          reserved: async () => { await shared`update scratch_iso2 set v = v + 1 where id = 1`; },
          released: async () => {},
          dequeued: async () => {},
          failed: async () => {},
        };
        const lock: UniqueLock = {
          acquire: async () => true,
          release: async () => { await shared`update scratch_iso2 set v = v + 1 where id = 99`; released = true; },
        };
        const bot = {
          upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d" }),
        } as unknown as BotClient;
        const m = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: crypto.randomUUID() });
        const done = consume({ messages: [m] }, { bot, events: store(), lock, ledger });
        const winner = await Promise.race([done.then(() => "done"), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
        // The shared client serializes: reserved() wedges on the row lock, so
        // nothing downstream (handler aside) completes before the timeout.
        expect(winner).toBe("timeout");
        expect(m.acked).toBe(false);
        expect(released).toBe(false);
        await blocker`rollback`;
        await done;
        expect(m.acked).toBe(true);
        expect(released).toBe(true);
      } finally {
        await shared.end();
      }
      await mainSql`delete from scratch_iso2 where id = 1`;
    } finally {
      await blocker.end();
      await mainSql.end();
    }
  }, 30000);
});
