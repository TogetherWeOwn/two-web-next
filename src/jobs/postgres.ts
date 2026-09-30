import type postgres from "postgres";
import type { SingleFlight, } from "./cron";
import type { UniqueLock } from "./types";

type Sql = ReturnType<typeof postgres>;

/** Transaction-scoped advisory lock: released on commit/rollback/disconnect, so a crashed run never wedges the job. */
export function pgSingleFlight(sql: Sql): SingleFlight {
  return async (name, fn) => {
    let ran = false;
    await sql.begin(async (tx) => {
      const [row] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) as got`;
      if (!row?.got) return; // another invocation holds it: skip, cheap when idle
      ran = true;
      await fn();
    });
    return ran;
  };
}

/** ShouldBeUnique lock with TTL (Cache::lock equivalent). Atomic: one upsert that only wins over expired rows. */
export function pgUniqueLock(sql: Sql): UniqueLock {
  return {
    async acquire(key, ttlSeconds) {
      const rows = await sql`
        insert into job_unique_locks (key, expires_at) values (${key}, now() + make_interval(secs => ${ttlSeconds}))
        on conflict (key) do update set expires_at = excluded.expires_at
          where job_unique_locks.expires_at < now()
        returning key`;
      return rows.length > 0;
    },
    async release(key) {
      await sql`delete from job_unique_locks where key = ${key}`;
    },
  };
}
