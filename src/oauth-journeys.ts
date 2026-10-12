// A signed browser cookie proves origin, not freshness or single use. Keep a
// hashed admission record in Postgres so competing Worker isolates share one
// winner before exchanging a code, writing an attempt or issuing a session.
import type { Sql } from "./sessions";

export const OAUTH_JOURNEY_TTL_SECONDS = 600;
export type OAuthFlow = "auth" | "join";
export type OAuthJourneyStore = {
  issue: (stateHash: string, flow: OAuthFlow) => Promise<boolean>;
  consume: (stateHash: string, flow: OAuthFlow) => Promise<boolean>;
  sweepExpired: () => Promise<number>;
};

const MIGRATION = [
  `create table if not exists web_oauth_journeys (
    state_hash text primary key,
    flow text not null check (flow in ('auth', 'join')),
    expires_at timestamptz not null,
    consumed_at timestamptz
  )`,
  `create index if not exists web_oauth_journeys_expires_at_idx on web_oauth_journeys (expires_at)`,
];

// Fixture helper only (TOG-19721): canonical DDL is
// drizzle/1022_web-sessions-oauth-journeys.sql. Reached via sessions
// migrate(); never from the request path (runtime role has no CREATE).
export async function migrateOAuthJourneys(sql: Sql): Promise<void> {
  for (const stmt of MIGRATION) await sql.unsafe(stmt);
}

export function createPostgresOAuthJourneyStore(sql: Sql): OAuthJourneyStore {
  return {
    async issue(stateHash, flow) {
      // A collision cannot resurrect a consumed journey. Cleanup is separate
      // from admission: deleting an expired row never makes an old cookie valid.
      const rows = await sql<
        { state_hash: string }[]
      >`insert into web_oauth_journeys (state_hash, flow, expires_at)
        values (${stateHash}, ${flow}, now() + ${OAUTH_JOURNEY_TTL_SECONDS} * interval '1 second')
        on conflict (state_hash) do nothing returning state_hash`;
      return rows.length === 1;
    },
    async consume(stateHash, flow) {
      // Evaluate eligibility from the locked output, not a separate base scan
      // that the planner can qualify before waiting. now() is frozen at statement
      // start, so expiry also requires the live clock after acquiring the lock.
      // Keep the tombstone until expiry; never delete on consume.
      const rows = await sql<{ state_hash: string }[]>`with locked as materialized (
          select state_hash, consumed_at, expires_at from web_oauth_journeys
          where state_hash = ${stateHash} and flow = ${flow} for update
        )
        update web_oauth_journeys j set consumed_at = clock_timestamp()
        from locked where j.state_hash = locked.state_hash
          and locked.consumed_at is null and locked.expires_at > clock_timestamp()
        returning j.state_hash`;
      return rows.length === 1;
    },
    async sweepExpired() {
      const rows = await sql<{ state_hash: string }[]>`delete from web_oauth_journeys
        where expires_at <= now() returning state_hash`;
      return rows.length;
    },
  };
}

/** Per-fixture helper only; production admission must use shared persistence. */
export function createMemoryOAuthJourneyStore(clock: () => number = Date.now): OAuthJourneyStore {
  const rows = new Map<string, { flow: OAuthFlow; expiresAt: number; consumed: boolean }>();
  return {
    async issue(stateHash, flow) {
      if (rows.has(stateHash)) return false;
      rows.set(stateHash, {
        flow,
        expiresAt: clock() + OAUTH_JOURNEY_TTL_SECONDS * 1000,
        consumed: false,
      });
      return true;
    },
    async consume(stateHash, flow) {
      const row = rows.get(stateHash);
      if (!row || row.flow !== flow || row.consumed || row.expiresAt <= clock()) return false;
      row.consumed = true;
      return true;
    },
    async sweepExpired() {
      let n = 0;
      for (const [hash, row] of rows) {
        if (row.expiresAt <= clock()) {
          rows.delete(hash);
          n++;
        }
      }
      return n;
    },
  };
}
