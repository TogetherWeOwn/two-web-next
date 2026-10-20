// Member erasure must keep chasing session successors for as long as
// rotations keep minting them. The sibling acceptance suite forces two
// passes; this one forces a third, so a loop capped at two passes (or any
// fixed number) cannot pass it.
//
// Chain, ordered with held row locks and pg_stat_activity observation, never
// sleeps-as-proof:
//   pass 1  erasure's session DELETE is parked on the plain row; rotation
//           A -> B commits while it waits, so B is invisible to pass 1.
//   pass 2  B is held, rotation B -> C is queued on it, and erasure's pass 2
//           DELETE queues behind that rotation; C commits after pass 2's
//           snapshot, so pass 2 cannot see it either.
//   pass 3  only a further fresh-snapshot pass can delete C.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countMemberRows, eraseMember, type ErasureCounts } from "../src/member-erasure";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const url = process.env.DATABASE_URL;
const VICTIM = "100000000000000403";

const session = (tokenHash: string) => ({
  tokenHash,
  userId: VICTIM,
  username: "erasure-chained-fixture",
  avatar: null,
  member: true,
  moderator: false,
  expiresAt: new Date(Date.now() + 3600_000),
});

describe.skipIf(!url)("member erasure against chained session rotations", () => {
  let fixture: JobsFixture;
  let store: ReturnType<typeof createPostgresSessionStore>;

  beforeAll(async () => {
    fixture = await createJobsFixture(url!, { max: 16 });
    await migrate(fixture.client as unknown as Sql);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
    await fixture.client`delete from users`;
    await fixture.client`insert into users (id, username, member)
      values (${VICTIM}, 'synthetic-erase-chain', true)`;
  });

  afterAll(async () => fixture?.dispose());

  const sql = () => fixture.client as unknown as Parameters<typeof eraseMember>[0];

  const sessionRows = async () => {
    const [row] = await fixture.client<{ n: number }[]>`select count(*)::int as n
      from web_sessions where user_id = ${VICTIM}`;
    return row?.n ?? 0;
  };

  function holdRow(tokenHash: string) {
    let release!: () => void;
    let signalLocked!: (pid: number) => void;
    let failLocked!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve, reject) => {
      signalLocked = resolve;
      failLocked = reject;
    });
    const done = (async () => {
      try {
        await fixture.client.begin(async (tx) => {
          const [holder] = await tx`select pg_backend_pid() as pid`;
          await tx`select token_hash from web_sessions where token_hash = ${tokenHash} for update`;
          signalLocked(holder!.pid);
          await gate;
        });
      } catch (error) {
        failLocked(error);
        throw error;
      }
    })();
    return { locked, release, done };
  }

  // Backends waiting on a lock held by one of the holders, directly or queued
  // behind another waiter of theirs.
  async function lockWaiters(holderPids: number[]) {
    const rows = await fixture.client<{ pid: number; blockers: number[] }[]>`
      select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    const waiting = new Set<number>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (waiting.has(row.pid)) continue;
        if (row.blockers.some((pid) => holderPids.includes(pid) || waiting.has(pid))) {
          waiting.add(row.pid);
          grew = true;
        }
      }
    }
    return waiting.size;
  }

  async function waitForLockWaiters(holderPids: number[], atLeast: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await lockWaiters(holderPids)) >= atLeast) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${atLeast} contender(s) reached the held row locks`);
  }

  it("converges over a successor minted by a rotation that was itself queued behind a successor", async () => {
    await store.create(session("chain-source"));
    await store.create(session("chain-plain"));
    const stableStatus = await store.statusHash("chain-source");
    expect(stableStatus).not.toBeNull();
    expect(await store.isActive(stableStatus!)).toBe(true);

    const sourceHold = holdRow("chain-source");
    const plainHold = holdRow("chain-plain");
    let secondHold: ReturnType<typeof holdRow> | undefined;
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    let erasure: Promise<ErasureCounts> | undefined;
    let erasureSettled = false;
    try {
      const plainPid = await plainHold.locked;
      const sourcePid = await sourceHold.locked;

      // Pass 1: the rotation is in flight on its source, erasure queues
      // behind it and then parks on the plain row.
      first = store.rotate("chain-source", session("chain-b"));
      await waitForLockWaiters([sourcePid, plainPid], 1);
      erasure = eraseMember(sql(), VICTIM, { dryRun: false }).then(
        (counts) => {
          erasureSettled = true;
          return counts;
        },
        (error: unknown) => {
          erasureSettled = true;
          throw error;
        },
      );
      await waitForLockWaiters([sourcePid, plainPid], 2);

      sourceHold.release();
      await sourceHold.done;
      expect(await first).toBe(true);
      expect(erasureSettled).toBe(false);
      expect(await store.get("chain-b")).not.toBeNull();

      // Pass 2 setup: hold B and queue the next rotation on it while
      // erasure is still parked in pass 1 on the plain row.
      secondHold = holdRow("chain-b");
      const bPid = await secondHold.locked;
      second = store.rotate("chain-b", session("chain-c"));
      await waitForLockWaiters([plainPid, bPid], 2);
      expect(erasureSettled).toBe(false);

      // Pass 1 finishes (B was minted after its snapshot, so it survives the
      // pass), pass 2 starts and queues behind the rotation on B.
      plainHold.release();
      await plainHold.done;
      await waitForLockWaiters([bPid], 2);
      expect(erasureSettled).toBe(false);

      // The rotation commits C after pass 2's snapshot: only a third pass
      // can delete it.
      secondHold.release();
      await secondHold.done;
      expect(await second).toBe(true);

      // plain (pass 1) + C (pass 3); A and B were deleted by the rotations.
      await expect(erasure).resolves.toEqual({
        users: 1,
        profiles: 0,
        rsvps: 0,
        web_sessions: 2,
        // A -> B was replaced by B -> C: only the immediate predecessor remains.
        web_session_grace: 1,
        join_attempts: 0,
      });
      expect(await sessionRows()).toBe(0);
      for (const token of ["chain-source", "chain-plain", "chain-b", "chain-c"])
        expect(await store.get(token), token).toBeNull();
      expect(await store.isActive(stableStatus!)).toBe(false);
      // The final successor cannot be rotated back to life afterwards.
      expect(await store.rotate("chain-c", session("chain-revival"))).toBe(false);
      expect(await store.get("chain-revival")).toBeNull();
      await expect(eraseMember(sql(), VICTIM, { dryRun: false })).resolves.toEqual({
        users: 0,
        profiles: 0,
        rsvps: 0,
        web_sessions: 0,
        web_session_grace: 0,
        join_attempts: 0,
      });
      expect(await countMemberRows(sql(), VICTIM)).toEqual({
        users: 0,
        profiles: 0,
        rsvps: 0,
        web_sessions: 0,
        web_session_grace: 0,
        join_attempts: 0,
      });
    } finally {
      sourceHold.release();
      plainHold.release();
      secondHold?.release();
      await Promise.allSettled(
        [sourceHold.done, plainHold.done, secondHold?.done, first, second, erasure].filter(Boolean),
      );
    }
  }, 15_000);
});
