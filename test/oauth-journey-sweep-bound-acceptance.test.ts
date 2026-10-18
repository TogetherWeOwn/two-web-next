// Acceptance oracle: one PostgreSQL expiry sweep of web_oauth_journeys removes
// at most the fixed 1000-row cleanup batch, reports the actual bounded count,
// and skips expired rows another transaction has row-locked instead of waiting
// on them. Repeated sweeps drain the eligible remainder. Live journeys and
// unexpired consumed tombstones survive, and the start sequence every auth/join
// route runs (sweep, then issue a fresh journey) completes while an unrelated
// expired journey stays locked. An unbounded sweep (first call reports the
// whole backlog) or a lock-waiting sweep (observed blocked on the holder via
// pg_blocking_pids) must fail this file; a genuine store failure must still
// reject rather than report a false clean sweep.
//
// Every case runs in a schema-owned disposable fixture on the guarded test
// database only; no external requests or credentials are involved.
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createPostgresOAuthJourneyStore, migrateOAuthJourneys } from "../src/oauth-journeys";
import { hashToken, type Sql } from "../src/sessions";
import { authTestDatabaseUrl } from "./helpers/auth-test-db";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const url = authTestDatabaseUrl();

// The existing cleanup precedent every other bounded sweep already follows.
const BATCH = 1000;

function schemaClient(fixture: JobsFixture, applicationName: string, max = 2) {
  return postgres(url!, {
    max,
    // Pin the guarded URL's password: postgres.js would otherwise fall back
    // to PGPASSWORD when the authorized test password is empty.
    password: () => new URL(url!).password,
    connection: { search_path: fixture.schemaName, application_name: applicationName },
    onnotice: () => {},
  });
}

async function freshStore(applicationName: string) {
  const fixture = await createJobsFixture(url!, { max: 4 });
  const client = schemaClient(fixture, applicationName, 4);
  await migrateOAuthJourneys(client as unknown as Sql);
  const store = createPostgresOAuthJourneyStore(client as unknown as Sql);
  return { fixture, client, store };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("bounded lock-skipping expiry sweep (test Postgres)", () => {
  it("removes at most one fixed batch per sweep, reports it, and drains on repeat", async () => {
    const { fixture, client, store } = await freshStore("oauth_sweep_bound");
    try {
      // Batch + 1 eligible expired rows, seeded as 64-char hash-shaped keys.
      await client`insert into web_oauth_journeys (state_hash, flow, expires_at)
        select lpad(to_hex(g), 64, '0'), 'auth', clock_timestamp() - interval '60 seconds'
        from generate_series(1, ${BATCH + 1}) g`;
      // Controls: one live journey per flow and one unexpired consumed
      // tombstone. None of them is sweep-eligible.
      const liveAuth = await hashToken(crypto.randomUUID());
      const liveJoin = await hashToken(crypto.randomUUID());
      const tombstone = await hashToken(crypto.randomUUID());
      expect(await store.issue(liveAuth, "auth")).toBe(true);
      expect(await store.issue(liveJoin, "join")).toBe(true);
      expect(await store.issue(tombstone, "join")).toBe(true);
      expect(await store.consume(tombstone, "join")).toBe(true);

      const expiredLeft = async () =>
        (
          await client<{ n: number }[]>`select count(*)::int as n from web_oauth_journeys
            where expires_at <= clock_timestamp()`
        )[0]!.n;
      expect(await expiredLeft()).toBe(BATCH + 1);

      // One sweep removes exactly one batch, not the whole backlog.
      expect(await store.sweepExpired()).toBe(BATCH);
      expect(await expiredLeft()).toBe(1);

      // Controls survived the bounded sweep with flow separation and the
      // single-use tombstone intact.
      expect(await store.consume(liveJoin, "auth")).toBe(false);
      expect(await store.consume(liveAuth, "auth")).toBe(true);
      expect(await store.consume(liveJoin, "join")).toBe(true);
      expect(await store.issue(tombstone, "join")).toBe(false);
      expect(await store.consume(tombstone, "join")).toBe(false);

      // Repeated sweeps drain the eligible remainder, then report clean.
      expect(await store.sweepExpired()).toBe(1);
      expect(await expiredLeft()).toBe(0);
      expect(await store.sweepExpired()).toBe(0);
      // Exactly the three controls remain (now all consumed tombstones).
      const total = await client<
        { n: number }[]
      >`select count(*)::int as n from web_oauth_journeys`;
      expect(total[0]!.n).toBe(3);
    } finally {
      await client.end({ timeout: 1 });
      await fixture.dispose();
    }
  });

  it("sweep and fresh issue complete while an unrelated expired journey is row-locked", async () => {
    const fixture = await createJobsFixture(url!, { max: 4 });
    const sweeperName = `oauth_sweep_lockskip_${crypto.randomUUID()}`;
    const sweeper = schemaClient(fixture, sweeperName, 1);
    const observer = schemaClient(fixture, "oauth_sweep_observer", 2);
    const locker = schemaClient(fixture, "oauth_sweep_locker", 1);
    try {
      await migrateOAuthJourneys(sweeper as unknown as Sql);
      const store = createPostgresOAuthJourneyStore(sweeper as unknown as Sql);

      const lockedHash = await hashToken(crypto.randomUUID());
      const freeHashes = await Promise.all(
        Array.from({ length: 3 }, () => hashToken(crypto.randomUUID())),
      );
      const liveHash = await hashToken(crypto.randomUUID());
      const past = new Date(Date.now() - 60_000);
      for (const hash of [lockedHash, ...freeHashes])
        await observer`insert into web_oauth_journeys (state_hash, flow, expires_at)
          values (${hash}, 'auth', ${past})`;
      expect(await store.issue(liveHash, "auth")).toBe(true);

      let sweep: Promise<number> | undefined;
      let completedBeforeRelease = false;
      let observedBlockedOnHolder = false;
      let issuedBeforeRelease: boolean[] = [];
      let lockedRowSurvivedSweep = false;
      let freeRowsGoneBeforeRelease = false;
      try {
        await locker.begin(async (tx) => {
          const [holder] = await tx`select pg_backend_pid() as pid`;
          await tx`select state_hash from web_oauth_journeys
            where state_hash = ${lockedHash} for update`;

          sweep = store.sweepExpired();
          let sweepSettled = false;
          void sweep.then(
            () => {
              sweepSettled = true;
            },
            () => {
              sweepSettled = true;
            },
          );
          // Deterministic synchronization: the sweep either completes here,
          // with the lock provably still held (this transaction is open), or
          // it is observed in pg_stat_activity blocked on this holder, in
          // which case it cannot complete before release. No fixed sleep
          // decides the outcome.
          const deadline = Date.now() + 10_000;
          for (;;) {
            if (sweepSettled) break;
            const rows = await observer<{ n: number }[]>`select count(*)::int as n
              from pg_stat_activity
              where application_name = ${sweeperName} and wait_event_type = 'Lock'
                and ${holder!.pid} = any(pg_blocking_pids(pid))`;
            if (rows[0]!.n === 1) {
              observedBlockedOnHolder = true;
              break;
            }
            if (Date.now() >= deadline)
              throw new Error("sweep neither completed nor reached the held row lock");
            await delay(5);
          }
          completedBeforeRelease = sweepSettled && !observedBlockedOnHolder;
          if (completedBeforeRelease) {
            await sweep;
            // The locked row was skipped, the free expired rows are gone,
            // and fresh journeys (the rest of the start sequence) issue fine.
            lockedRowSurvivedSweep =
              (
                await observer`select 1 from web_oauth_journeys
                  where state_hash = ${lockedHash}`
              ).length === 1;
            freeRowsGoneBeforeRelease =
              (
                await observer<{ n: number }[]>`select count(*)::int as n
                  from web_oauth_journeys where state_hash in ${observer(freeHashes)}`
              )[0]!.n === 0;
            issuedBeforeRelease = await Promise.all(
              (["auth", "join"] as const).map(async (flow) =>
                store.issue(await hashToken(crypto.randomUUID()), flow),
              ),
            );
          }
        });
        // Settle the sweep before asserting so a blocked sweep drains here
        // instead of leaking into teardown.
        const swept = await sweep!;
        expect(observedBlockedOnHolder).toBe(false);
        expect(completedBeforeRelease).toBe(true);
        // Only the three unlocked expired rows were reported removed.
        expect(swept).toBe(3);
        expect(lockedRowSurvivedSweep).toBe(true);
        expect(freeRowsGoneBeforeRelease).toBe(true);
        expect(issuedBeforeRelease).toEqual([true, true]);

        // The live control is untouched, and once the lock is released the
        // skipped row becomes eligible for the next sweep.
        expect(await store.consume(liveHash, "auth")).toBe(true);
        expect(await store.sweepExpired()).toBe(1);
        expect(
          (await observer`select 1 from web_oauth_journeys where state_hash = ${lockedHash}`)
            .length,
        ).toBe(0);
        expect(await store.sweepExpired()).toBe(0);
      } finally {
        await sweep?.catch(() => {});
      }
    } finally {
      await sweeper.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await locker.end({ timeout: 1 });
      await fixture.dispose();
    }
  });

  it("a genuine store failure rejects instead of reporting a clean sweep", async () => {
    const { fixture, client, store } = await freshStore("oauth_sweep_failure");
    try {
      await client`drop table web_oauth_journeys`;
      await expect(store.sweepExpired()).rejects.toThrow();
    } finally {
      await client.end({ timeout: 1 });
      await fixture.dispose();
    }
  });
});
