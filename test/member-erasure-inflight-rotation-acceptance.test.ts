// Acceptance suite: member erasure must also remove the successors of
// rotations that were already in flight when erasure reached its session
// removal. A rotation holds its source row, deletes it and inserts a
// different successor in one statement; an erasure statement whose snapshot
// predates that commit cannot see the successor, so a single-pass session
// deletion reports success while the erased member stays signed in.
//
// Contract pinned here:
// (1) a successful erase leaves neither an in-flight rotation's source nor
//     its successor authenticatable, the stable status probe is inactive,
//     and no physical session row for the member remains;
// (2) several pre-existing in-flight rotations converge in the same erase
//     with truthful accumulated web_sessions counts (rows the erase itself
//     physically deleted), without touching another member;
// (3) the six-table transaction stays atomic: ordinary deletion, a repeat
//     apply returning zero, a read-only dry-run, and a whole-transaction
//     rollback on a database failure;
// (4) erasure is not a tombstone: a genuinely new sign-in afterwards works.
//
// The races are ordered with held row locks, never sleeps-as-proof: holder
// transactions lock the session rows, the contenders are started in a chosen
// order, their lock waits are observed in pg_stat_activity, and only then is
// each holder released. The erased member's plain (non-rotating) session
// stays held until every rotation has committed, which keeps erasure
// verifiably in flight at its competing session removal while the
// successors are minted.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countMemberRows,
  eraseMember,
  type ErasureCounts,
  type ErasureResult,
} from "../src/member-erasure";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const url = process.env.DATABASE_URL;
const VICTIM = "100000000000000401";
const BYSTANDER = "100000000000000402";
const EVENT_KEY = "01J000000000000000000000E4";

const session = (tokenHash: string, userId = VICTIM) => ({
  tokenHash,
  userId,
  username: "erasure-inflight-fixture",
  avatar: null,
  member: true,
  moderator: false,
  expiresAt: new Date(Date.now() + 3600_000),
});

const ZERO: ErasureCounts = {
  users: 0,
  profiles: 0,
  rsvps: 0,
  member_links: 0,
  web_sessions: 0,
  web_session_grace: 0,
  join_attempts: 0,
};

describe.skipIf(!url)("member erasure against already-in-flight rotations", () => {
  let fixture: JobsFixture;
  let store: ReturnType<typeof createPostgresSessionStore>;
  let eventId: number;

  beforeAll(async () => {
    fixture = await createJobsFixture(url!, { max: 16 });
    await migrate(fixture.client as unknown as Sql);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
    await fixture.client`delete from rsvps`;
    await fixture.client`delete from profiles`;
    await fixture.client`delete from join_attempts`;
    await fixture.client`delete from events`;
    await fixture.client`delete from users`;
    const [event] = (await fixture.client`insert into events
      (event_key, title, starts_at, ends_at) values
      (${EVENT_KEY}, 'Synthetic erasure race event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z')
      returning id`) as { id: number }[];
    eventId = event!.id;
  });

  afterAll(async () => fixture?.dispose());

  const sql = () => fixture.client as unknown as Parameters<typeof eraseMember>[0];

  // Seed the four non-session erasure tables; sessions go through the real
  // store so status hashes and rotation lineage match production rows.
  const seedMember = async (id: string, username: string) => {
    await fixture.client`insert into users (id, username, member) values (${id}, ${username}, true)`;
    await fixture.client`insert into profiles (user_id, bio, games, timezone)
      values (${id}, ${`bio for ${id}`}, '["Synthetic Game"]', 'Europe/London')`;
    await fixture.client`insert into rsvps (event_id, user_id, status)
      values (${eventId}, ${id}, 'going')`;
    await fixture.client`insert into join_attempts (outcome, source, request_id, discord_id)
      values ('added', 'site', ${`request-${id}`}, ${id})`;
  };

  // Physical rows, live or not: erasure is deletion, not a revocation stamp.
  const sessionRows = async (userId: string) => {
    const [row] = await fixture.client<{ n: number }[]>`select count(*)::int as n
      from web_sessions where user_id = ${userId}`;
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

  // Count backends waiting on a lock held by one of the holders, directly or
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

  it("removes the successor of a rotation already in flight at the session deletion", async () => {
    await seedMember(VICTIM, "synthetic-erase-race-a");
    await seedMember(BYSTANDER, "synthetic-erase-race-b");
    await store.create(session("race-source"));
    await store.create(session("race-plain"));
    await store.create(session("race-bystander", BYSTANDER));
    const stableStatus = await store.statusHash("race-source");
    expect(stableStatus).not.toBeNull();
    // The stable probe survives ordinary rotation by design; capture it now
    // so the post-erasure check proves erasure, not rotation, ended it.
    expect(await store.isActive(stableStatus!)).toBe(true);

    const sourceHold = holdRow("race-source");
    const plainHold = holdRow("race-plain");
    let rotation: Promise<boolean> | undefined;
    let erasure: Promise<ErasureResult> | undefined;
    let erasureSettled = false;
    try {
      const holderPids = [await sourceHold.locked, await plainHold.locked];
      // The rotation is already in flight, parked on its held source.
      rotation = store.rotate("race-source", session("race-successor"));
      await waitForLockWaiters(holderPids, 1);
      // Erasure starts behind it; its earlier tables do not contend for the
      // held session rows, so the second waiter proves erasure has reached
      // the competing session removal with the rotation still in flight.
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
      await waitForLockWaiters(holderPids, 2);

      sourceHold.release();
      await sourceHold.done;
      // The queued rotation mints its successor while erasure is still in
      // flight against the other held row.
      expect(await rotation).toBe(true);
      expect(erasureSettled).toBe(false);
      expect(await store.get("race-successor")).not.toBeNull();

      plainHold.release();
      await plainHold.done;

      // Truthful accumulated count: rotation deleted the source itself, so
      // erasure physically deleted the plain session and the successor.
      // Pass count depends on the race interleaving, so pin the counts plus
      // the pass invariants rather than an exact pass array.
      const raced = await erasure!;
      expect(raced).toMatchObject({
        users: 1,
        profiles: 1,
        rsvps: 1,
        member_links: 0,
        web_sessions: 2,
        web_session_grace: 1,
        join_attempts: 1,
      });
      expect(raced.passes).toBe(raced.deletesPerPass.length);
      expect(raced.deletesPerPass.reduce((total, deleted) => total + deleted, 0)).toBe(
        raced.web_sessions,
      );
      expect(await sessionRows(VICTIM)).toBe(0);
      expect(await store.get("race-source")).toBeNull();
      expect(await store.get("race-successor")).toBeNull();
      expect(await store.get("race-plain")).toBeNull();
      expect(await store.isActive(stableStatus!)).toBe(false);
      // The minted successor cannot be rotated back to life afterwards.
      expect(await store.rotate("race-successor", session("race-revival"))).toBe(false);
      expect(await store.get("race-revival")).toBeNull();
      // Repeat apply is a no-op across all seven tables.
      await expect(eraseMember(sql(), VICTIM, { dryRun: false })).resolves.toEqual({
        ...ZERO,
        passes: 1,
        deletesPerPass: [0],
      });
      // The other member is untouched everywhere.
      expect(await countMemberRows(sql(), BYSTANDER)).toEqual({
        users: 1,
        profiles: 1,
        rsvps: 1,
        member_links: 0,
        web_sessions: 1,
        web_session_grace: 0,
        join_attempts: 1,
      });
      expect(await store.get("race-bystander")).not.toBeNull();
    } finally {
      sourceHold.release();
      plainHold.release();
      await Promise.allSettled(
        [sourceHold.done, plainHold.done, rotation, erasure].filter(Boolean),
      );
    }
  }, 15_000);

  it("converges over multiple in-flight source rotations and isolates another member", async () => {
    await seedMember(VICTIM, "synthetic-erase-multi-a");
    await seedMember(BYSTANDER, "synthetic-erase-multi-b");
    const sources = ["multi-source-1", "multi-source-2", "multi-source-3"];
    const successors = sources.map((source) => source.replace("source", "successor"));
    for (const source of sources) await store.create(session(source));
    await store.create(session("multi-plain"));
    await store.create(session("multi-bystander-source", BYSTANDER));
    const stableStatuses: string[] = [];
    for (const source of sources) {
      const status = await store.statusHash(source);
      expect(status).not.toBeNull();
      stableStatuses.push(status!);
    }

    const sourceHolds = sources.map((source) => holdRow(source));
    const plainHold = holdRow("multi-plain");
    const rotations: Promise<boolean>[] = [];
    let erasure: Promise<ErasureResult> | undefined;
    let erasureSettled = false;
    try {
      const holderPids = [
        ...(await Promise.all(sourceHolds.map((h) => h.locked))),
        await plainHold.locked,
      ];
      for (const [i, source] of sources.entries())
        rotations.push(store.rotate(source, session(successors[i]!)));
      await waitForLockWaiters(holderPids, sources.length);
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
      await waitForLockWaiters(holderPids, sources.length + 1);

      // Every already-in-flight rotation commits a successor while erasure
      // is still held in flight by the plain session.
      for (const [i, hold] of sourceHolds.entries()) {
        hold.release();
        await hold.done;
        expect(await rotations[i]).toBe(true);
      }
      expect(erasureSettled).toBe(false);
      for (const successor of successors) expect(await store.get(successor)).not.toBeNull();
      // Another member's ordinary rotation proceeds and stays valid: scope
      // is the erased member only, even mid-erasure.
      expect(
        await store.rotate(
          "multi-bystander-source",
          session("multi-bystander-successor", BYSTANDER),
        ),
      ).toBe(true);

      plainHold.release();
      await plainHold.done;

      // Plain session plus all three successors, accumulated truthfully.
      // Pass count depends on the race interleaving, so pin the counts plus
      // the pass invariants rather than an exact pass array.
      const multi = await erasure!;
      expect(multi).toMatchObject({
        users: 1,
        profiles: 1,
        rsvps: 1,
        member_links: 0,
        web_sessions: 4,
        web_session_grace: 3,
        join_attempts: 1,
      });
      expect(multi.passes).toBe(multi.deletesPerPass.length);
      expect(multi.deletesPerPass.reduce((total, deleted) => total + deleted, 0)).toBe(
        multi.web_sessions,
      );
      expect(await sessionRows(VICTIM)).toBe(0);
      for (const token of [...sources, ...successors, "multi-plain"])
        expect(await store.get(token), token).toBeNull();
      for (const status of stableStatuses) expect(await store.isActive(status)).toBe(false);
      for (const successor of successors)
        expect(await store.rotate(successor, session(`${successor}-revival`))).toBe(false);
      expect(await countMemberRows(sql(), BYSTANDER)).toEqual({
        users: 1,
        profiles: 1,
        rsvps: 1,
        member_links: 0,
        web_sessions: 1,
        web_session_grace: 1,
        join_attempts: 1,
      });
      expect(await store.get("multi-bystander-source")).toMatchObject({ userId: BYSTANDER });
      expect(await store.get("multi-bystander-successor")).toMatchObject({ userId: BYSTANDER });
    } finally {
      for (const hold of sourceHolds) hold.release();
      plainHold.release();
      await Promise.allSettled(
        [...sourceHolds.map((h) => h.done), plainHold.done, ...rotations, erasure].filter(Boolean),
      );
    }
  }, 15_000);

  it("lets an erasure queued ahead of rotation win without minting a successor (control)", async () => {
    await seedMember(VICTIM, "synthetic-erase-ahead-a");
    await store.create(session("ahead-source"));

    const hold = holdRow("ahead-source");
    let rotation: Promise<boolean> | undefined;
    let erasure: Promise<ErasureResult> | undefined;
    try {
      const holderPids = [await hold.locked];
      erasure = eraseMember(sql(), VICTIM, { dryRun: false });
      await waitForLockWaiters(holderPids, 1);
      rotation = store.rotate("ahead-source", session("ahead-successor"));
      await waitForLockWaiters(holderPids, 2);

      hold.release();
      await hold.done;

      const won = await erasure!;
      expect(won).toMatchObject({
        users: 1,
        profiles: 1,
        rsvps: 1,
        member_links: 0,
        web_sessions: 1,
        web_session_grace: 0,
        join_attempts: 1,
      });
      expect(won.passes).toBe(won.deletesPerPass.length);
      expect(won.deletesPerPass.reduce((total, deleted) => total + deleted, 0)).toBe(
        won.web_sessions,
      );
      expect(await rotation).toBe(false);
      expect(await store.get("ahead-successor")).toBeNull();
      expect(await sessionRows(VICTIM)).toBe(0);
    } finally {
      hold.release();
      await Promise.allSettled([hold.done, rotation, erasure].filter(Boolean));
    }
  }, 15_000);

  it("keeps dry-run read-only around rotation and erases a settled successor (controls)", async () => {
    await seedMember(VICTIM, "synthetic-erase-dry-a");
    await store.create(session("dry-source"));
    await store.create(session("dry-plain"));

    await expect(eraseMember(sql(), VICTIM, { dryRun: true })).resolves.toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
      passes: 0,
      deletesPerPass: [],
    });
    // Legitimate rotation yields one live successor and its predecessor grace.
    expect(await store.rotate("dry-source", session("dry-successor"))).toBe(true);
    expect(await store.get("dry-source")).toMatchObject({ userId: VICTIM });
    expect(await store.get("dry-successor")).toMatchObject({ userId: VICTIM });
    // Dry-run wrote nothing and still reports the rotated shape truthfully.
    await expect(eraseMember(sql(), VICTIM, { dryRun: true })).resolves.toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 1,
      join_attempts: 1,
      passes: 0,
      deletesPerPass: [],
    });
    expect(await store.get("dry-source")).toMatchObject({ userId: VICTIM });
    expect(await sessionRows(VICTIM)).toBe(2);

    // Sequential order: erasure removes both live sessions and the grace row.
    await expect(eraseMember(sql(), VICTIM, { dryRun: false })).resolves.toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 1,
      join_attempts: 1,
      passes: 1,
      deletesPerPass: [2],
    });
    expect(await sessionRows(VICTIM)).toBe(0);
    expect(await store.get("dry-source")).toBeNull();
    expect(await store.get("dry-successor")).toBeNull();
    await expect(eraseMember(sql(), VICTIM, { dryRun: false })).resolves.toEqual({
      ...ZERO,
      passes: 1,
      deletesPerPass: [0],
    });

    // Boundary: erasure is not a tombstone or a sign-in ban. A genuinely new
    // session created after erasure authenticates normally.
    await store.create(session("dry-new-signin"));
    expect(await store.get("dry-new-signin")).toMatchObject({ userId: VICTIM });
  });

  it("rolls back all seven tables when a late deletion fails (control)", async () => {
    await seedMember(VICTIM, "synthetic-erase-rollback-a");
    await seedMember(BYSTANDER, "synthetic-erase-rollback-b");
    await store.create(session("rollback-source"));
    await store.create(session("rollback-bystander", BYSTANDER));
    expect(await store.rotate("rollback-source", session("rollback-successor"))).toBe(true);
    const before = await countMemberRows(sql(), VICTIM);
    expect(before).toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 1,
      web_session_grace: 1,
      join_attempts: 1,
    });

    // Fail the last of the six deletions from inside the database: every
    // earlier deletion in the transaction must be rolled back with it, and
    // no successful counts may be returned.
    await fixture.client.unsafe(
      `create function erasure_rollback_guard() returns trigger language plpgsql as 'begin raise exception ''synthetic erasure failure''; end'`,
    );
    await fixture.client.unsafe(
      `create trigger erasure_rollback_guard before delete on join_attempts for each row execute function erasure_rollback_guard()`,
    );
    try {
      await expect(eraseMember(sql(), VICTIM, { dryRun: false })).rejects.toThrow(
        "synthetic erasure failure",
      );
      expect(await countMemberRows(sql(), VICTIM)).toEqual(before);
      expect(await store.get("rollback-source")).toMatchObject({ userId: VICTIM });
      expect(await store.get("rollback-successor")).toMatchObject({ userId: VICTIM });
    } finally {
      await fixture.client.unsafe(`drop trigger if exists erasure_rollback_guard on join_attempts`);
      await fixture.client.unsafe(`drop function if exists erasure_rollback_guard()`);
    }
    // With the failure removed the same erase succeeds against intact rows.
    await expect(eraseMember(sql(), VICTIM, { dryRun: false })).resolves.toEqual({
      ...before,
      passes: 1,
      deletesPerPass: [1],
    });
    expect(await countMemberRows(sql(), VICTIM)).toEqual(ZERO);
    expect(await store.get("rollback-source")).toBeNull();
    expect(await store.get("rollback-successor")).toBeNull();
    expect(await countMemberRows(sql(), BYSTANDER)).toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 1,
      web_session_grace: 0,
      join_attempts: 1,
    });
  }, 15_000);
});
