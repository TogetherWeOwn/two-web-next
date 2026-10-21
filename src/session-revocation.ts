// Operator revocation of one member's active web sessions.
import { assertDiscordId } from "./member-erasure";

export type SessionRevocationCounts = { web_sessions: number };

/**
 * Revocation result: the stamped count plus chase forensics. `passes` is the
 * number of chase passes executed and `stampsPerPass` the sessions each pass
 * stamped, in order. On apply results `passes === stampsPerPass.length` and
 * `web_sessions === sum(stampsPerPass)` hold; dry-run returns `passes: 0`
 * with an empty array next to the counted `web_sessions`. Numbers only, never ids.
 */
export type SessionRevocationResult = SessionRevocationCounts & {
  passes: number;
  stampsPerPass: number[];
};

export type SessionRevocationTx = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

export type SessionRevocationSql = SessionRevocationTx & {
  begin: <T>(fn: (tx: SessionRevocationTx) => Promise<T>) => Promise<T>;
};

/** Count only sessions that are currently usable by authenticated requests. */
export async function countActiveMemberSessions(
  sql: SessionRevocationTx,
  discordId: string,
): Promise<SessionRevocationCounts> {
  assertDiscordId(discordId);
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from web_sessions
    where user_id = ${discordId} and revoked_at is null and expires_at > clock_timestamp()`;
  return { web_sessions: row?.n ?? 0 };
}

/** Revoke active sessions atomically using the database clock. */
export async function revokeMemberSessions(
  sql: SessionRevocationSql,
  discordId: string,
  opts: { dryRun: boolean },
): Promise<SessionRevocationResult> {
  assertDiscordId(discordId);
  if (opts.dryRun) {
    const counts = await countActiveMemberSessions(sql, discordId);
    return { ...counts, passes: 0, stampsPerPass: [] };
  }
  return sql.begin(async (tx) => {
    let revoked = 0;
    const stampsPerPass: number[] = [];
    // An in-flight rotation can replace a locked row after this UPDATE's
    // statement snapshot. Recount with a fresh snapshot and catch its successor.
    // The loop has no pass cap on purpose: a bounded cap throws away (by
    // rolling back) every stamp collected so far, so sustained rotation always
    // outlasts it while the victim stays signed in. Each pass stamps every
    // revocable row in a fresh snapshot and holds those row locks to commit,
    // so a rotation racing a stamped row parks on its lock and then fails on
    // the revoked source without minting; only rotations already holding a
    // source lock can still commit a successor, bounding each pass's miss to
    // the instantaneously in-flight frontier. Passes therefore chase a
    // shrinking frontier until one pass observes quiescence. Database errors
    // still propagate and roll the whole revocation back.
    for (;;) {
      const rows = await tx`update web_sessions
        set revoked_at = clock_timestamp()
        where user_id = ${discordId} and revoked_at is null and expires_at > clock_timestamp()
        returning 1`;
      revoked += rows.length;
      stampsPerPass.push(rows.length);
      const remaining = await countActiveMemberSessions(tx, discordId);
      if (remaining.web_sessions === 0)
        return { web_sessions: revoked, passes: stampsPerPass.length, stampsPerPass };
    }
  });
}
