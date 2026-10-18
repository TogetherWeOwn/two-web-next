import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";
import { countActiveMemberSessions, revokeMemberSessions } from "../src/session-revocation";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

// Acceptance suite: member-session revocation must converge while the
// victim's sessions are actively rotating.
// Pins: (1) revocation never throws with revocable sessions live and its
// reported count is complete, (2) rotation during revocation leaves zero
// live victim sessions while legitimate rotation still yields one live
// successor, (3) dryRun stays read-only and unexpired-only scoping holds.
// The races are ordered with held row locks, not sleeps-as-ordering: a
// holder transaction locks a session row, the contenders are started in a
// chosen order, lock waits are observed in pg_stat_activity, and only then
// is each holder released.

const url = process.env.DATABASE_URL;
const VICTIM = "100000000000000301";
const BYSTANDER = "100000000000000302";

const session = (tokenHash: string, userId = VICTIM) => ({
  tokenHash,
  userId,
  username: "revocation-rotation-fixture",
  avatar: null,
  member: true,
  moderator: false,
  expiresAt: new Date(Date.now() + 3600_000),
});

describe.skipIf(!url)("revocation converging under active rotation", () => {
  let fixture: JobsFixture;
  let store: ReturnType<typeof createPostgresSessionStore>;

  beforeAll(async () => {
    fixture = await createJobsFixture(url!, { max: 10 });
    await migrate(fixture.client as unknown as Sql);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_sessions`;
  });

  afterAll(async () => fixture?.dispose());

  const sql = () => fixture.client as unknown as Parameters<typeof revokeMemberSessions>[0];

  const liveCount = async (userId: string) => {
    const [row] = await fixture.client<{ n: number }[]>`select count(*)::int as n from web_sessions
      where user_id = ${userId} and revoked_at is null and expires_at > clock_timestamp()`;
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

  // Count sessions waiting on a lock held by one of the holders, directly or
  // queued behind another waiter of theirs.
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

  it("catches a successor minted while revocation is in flight and counts it", async () => {
    await store.create(session("converge-source"));
    await store.create(session("converge-plain"));
    await store.create(session("converge-other-user", BYSTANDER));

    const sourceHold = holdRow("converge-source");
    const plainHold = holdRow("converge-plain");
    let rotation: Promise<boolean> | undefined;
    let revocation: ReturnType<typeof revokeMemberSessions> | undefined;
    try {
      const holderPids = [await sourceHold.locked, await plainHold.locked];
      // Rotation queues first for the source row; revocation starts behind it
      // and is in flight (blocked on a held row) before either holder moves.
      rotation = store.rotate("converge-source", session("converge-successor"));
      await waitForLockWaiters(holderPids, 1);
      revocation = revokeMemberSessions(sql(), VICTIM, { dryRun: false });
      await waitForLockWaiters(holderPids, 2);

      sourceHold.release();
      await sourceHold.done;
      // The rotation queued ahead mints its successor while revocation is
      // still in flight against the other held row.
      expect(await rotation).toBe(true);

      plainHold.release();
      await plainHold.done;

      // Complete count: the plain session and the successor minted mid-flight.
      await expect(revocation).resolves.toEqual({ web_sessions: 2 });
      expect(await liveCount(VICTIM)).toBe(0);
      expect(await store.get("converge-successor")).toBeNull();
      expect(await store.get("converge-plain")).toBeNull();
      expect(await store.get("converge-other-user")).not.toBeNull();
      // The minted successor cannot be rotated back to life afterwards.
      expect(await store.rotate("converge-successor", session("converge-revival"))).toBe(false);
      expect(await store.get("converge-revival")).toBeNull();
    } finally {
      sourceHold.release();
      plainHold.release();
      await Promise.allSettled(
        [sourceHold.done, plainHold.done, rotation, revocation].filter(Boolean),
      );
    }
  }, 15_000);

  it("never throws under sustained rotation and leaves zero live sessions", async () => {
    // Sustained rotation, made deterministic: rotating chains run on their
    // own pool while a locked "gate" session stalls revocation mid-pass.
    // Each cycle, while revocation is verifiably blocked on the current
    // gate, the chains rotate (fresh successors the in-flight pass cannot
    // have seen) and a fresh gate session appears; only then is the old
    // gate released. A revocation that gives up after a bounded number of
    // passes therefore throws with the victim still signed in, while a
    // converging one finishes once the cycles stop.
    const CHAINS = 24;
    const CYCLES = 12;
    await Promise.all(
      Array.from({ length: CHAINS }, (_, c) => store.create(session(`loop-${c}-seed`))),
    );
    await store.create(session("loop-other-user", BYSTANDER));
    await store.create(session("loop-gate-0"));

    const parsed = new URL(url!);
    const attackerPool = postgres(parsed.href, {
      max: 16,
      port: 5432,
      connect_timeout: 5,
      password: () => parsed.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    const attackerStore = createPostgresSessionStore(attackerPool as unknown as Sql);

    let stop = false;
    let rotations = 0;
    const chains = Array.from({ length: CHAINS }, (_, c) =>
      (async () => {
        let current = `loop-${c}-seed`;
        for (let i = 0; i < 5000 && !stop; i++) {
          const next = `loop-${c}-step-${i}`;
          if (!(await attackerStore.rotate(current, session(next)))) break;
          current = next;
          rotations++;
        }
        return current;
      })(),
    );

    let gate = holdRow("loop-gate-0");
    const gates: ReturnType<typeof holdRow>[] = [gate];
    let revocation: ReturnType<typeof revokeMemberSessions> | undefined;
    try {
      const warmDeadline = Date.now() + 10_000;
      while (rotations < CHAINS * 3 && Date.now() < warmDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(rotations).toBeGreaterThanOrEqual(CHAINS * 3);

      let settled = false;
      revocation = revokeMemberSessions(sql(), VICTIM, { dryRun: false });
      const outcomePromise = revocation.then(
        (value) => {
          settled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );

      for (let cycle = 0; cycle < CYCLES && !settled; cycle++) {
        const holderPid = await gate.locked;
        const blockDeadline = Date.now() + 5000;
        while (!settled && Date.now() < blockDeadline && (await lockWaiters([holderPid])) < 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (settled) break;
        // Revocation is blocked mid-pass on this gate: let every chain mint
        // at least one successor it cannot have seen, then add the next gate.
        const rotationsAtBlock = rotations;
        const spinDeadline = Date.now() + 5000;
        while (rotations < rotationsAtBlock + CHAINS && Date.now() < spinDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await store.create(session(`loop-gate-${cycle + 1}`));
        const nextGate = holdRow(`loop-gate-${cycle + 1}`);
        gates.push(nextGate);
        await nextGate.locked;
        gate.release();
        await gate.done;
        gate = nextGate;
      }
      gate.release();

      const outcome = await outcomePromise;
      const liveAtReturn = await liveCount(VICTIM);
      stop = true;
      const finals = await Promise.all(chains);

      // Never throws with revocable sessions live, and zero live at return.
      expect(outcome.ok, outcome.ok ? "" : String(outcome.error)).toBe(true);
      expect(liveAtReturn).toBe(0);
      // No chain revives after settling, and the count is complete: every
      // session row the revocation stamped is still present (a revoked row
      // cannot be rotated away), so the report equals the stamped rows.
      expect(await liveCount(VICTIM)).toBe(0);
      expect(await countActiveMemberSessions(sql(), VICTIM)).toEqual({ web_sessions: 0 });
      const [stamped] = await fixture.client<
        { n: number }[]
      >`select count(*)::int as n from web_sessions
        where user_id = ${VICTIM} and revoked_at is not null`;
      if (outcome.ok) expect(outcome.value.web_sessions).toBe(stamped?.n);
      for (const final of finals.slice(0, 8)) {
        expect(await attackerStore.rotate(final, session(`${final}-revival`))).toBe(false);
        expect(await store.get(`${final}-revival`)).toBeNull();
      }
      expect(await store.get("loop-other-user")).not.toBeNull();
    } finally {
      stop = true;
      for (const held of gates) held.release();
      await Promise.allSettled(
        [...gates.map((held) => held.done), ...chains, revocation].filter(Boolean),
      );
      await attackerPool.end({ timeout: 1 });
    }
  }, 60_000);

  it("lets a revocation queued ahead of rotation win without minting a successor", async () => {
    await store.create(session("ahead-source"));

    const hold = holdRow("ahead-source");
    let rotation: Promise<boolean> | undefined;
    let revocation: ReturnType<typeof revokeMemberSessions> | undefined;
    try {
      const holderPids = [await hold.locked];
      revocation = revokeMemberSessions(sql(), VICTIM, { dryRun: false });
      await waitForLockWaiters(holderPids, 1);
      rotation = store.rotate("ahead-source", session("ahead-successor"));
      await waitForLockWaiters(holderPids, 2);

      hold.release();
      await hold.done;

      await expect(revocation).resolves.toEqual({ web_sessions: 1 });
      expect(await rotation).toBe(false);
      expect(await store.get("ahead-successor")).toBeNull();
      expect(await liveCount(VICTIM)).toBe(0);
    } finally {
      hold.release();
      await Promise.allSettled([hold.done, rotation, revocation].filter(Boolean));
    }
  }, 15_000);

  it("keeps dryRun read-only around rotation (positive control)", async () => {
    await store.create(session("dry-source"));
    await store.create(session("dry-plain"));

    expect(await revokeMemberSessions(sql(), VICTIM, { dryRun: true })).toEqual({
      web_sessions: 2,
    });
    expect(await liveCount(VICTIM)).toBe(2);
    // Legitimate rotation still yields exactly one live successor.
    expect(await store.rotate("dry-source", session("dry-successor"))).toBe(true);
    expect(await store.get("dry-source")).toBeNull();
    expect(await store.get("dry-successor")).toMatchObject({ userId: VICTIM });
    expect(await liveCount(VICTIM)).toBe(2);
    expect(await revokeMemberSessions(sql(), VICTIM, { dryRun: true })).toEqual({
      web_sessions: 2,
    });
    expect(await liveCount(VICTIM)).toBe(2);
  });

  it("scopes revocation to unexpired, unrevoked sessions of the target (positive control)", async () => {
    const later = new Date(Date.now() + 3600_000).toISOString();
    const earlier = new Date(Date.now() - 3600_000).toISOString();
    await fixture.client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at, revoked_at)
      values ('scope-live', ${VICTIM}, 'scope', true, false, ${later}, null),
             ('scope-expired', ${VICTIM}, 'scope', true, false, ${earlier}, null),
             ('scope-revoked', ${VICTIM}, 'scope', true, false, ${later}, clock_timestamp()),
             ('scope-other', ${BYSTANDER}, 'scope', true, false, ${later}, null)`;

    expect(await revokeMemberSessions(sql(), VICTIM, { dryRun: false })).toEqual({
      web_sessions: 1,
    });
    const rows = await fixture.client<{ token_hash: string; revoked: boolean }[]>`
      select token_hash, revoked_at is not null as revoked from web_sessions order by token_hash`;
    expect(rows).toEqual([
      { token_hash: "scope-expired", revoked: false },
      { token_hash: "scope-live", revoked: true },
      { token_hash: "scope-other", revoked: false },
      { token_hash: "scope-revoked", revoked: true },
    ]);
    // A second run with nothing revocable live reports zero and does not throw.
    expect(await revokeMemberSessions(sql(), VICTIM, { dryRun: false })).toEqual({
      web_sessions: 0,
    });
  });

  it("revokes a successor when rotation finished first (positive control)", async () => {
    await store.create(session("seq-source"));
    expect(await store.rotate("seq-source", session("seq-successor"))).toBe(true);
    expect(await revokeMemberSessions(sql(), VICTIM, { dryRun: false })).toEqual({
      web_sessions: 1,
    });
    expect(await liveCount(VICTIM)).toBe(0);
    expect(await store.get("seq-successor")).toBeNull();
  });
});
