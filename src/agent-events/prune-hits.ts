import type { Sql } from "postgres";

const PRUNE_BATCH_SIZE = 1000;
const PRUNE_LOCK_TIMEOUT_MS = 1;
const PRUNE_LOCK_KEY = "agent-event-hits:prune";

/** Best-effort stale-hit cleanup; it never holds an admission bucket lock. */
export async function pruneAgentEventHits(sql: Sql): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${PRUNE_LOCK_TIMEOUT_MS}ms'`);
      const [lock] = await tx`
        select pg_try_advisory_xact_lock(hashtextextended(${PRUNE_LOCK_KEY}, 0)) as got`;
      if (!lock?.got) return;
      await tx`delete from agent_event_hits where id in (
        select id from agent_event_hits
        where at < now() - interval '5 minutes'
        order by at, id limit ${PRUNE_BATCH_SIZE}
      )`;
    });
  } catch {
    // Housekeeping must not change an admission or throttle verdict. A row held
    // elsewhere makes this bounded statement defer cleanup to a later pass.
  }
}
