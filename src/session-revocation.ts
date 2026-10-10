// Operator revocation of one member's active web sessions.
import { assertDiscordId } from "./member-erasure";

export type SessionRevocationCounts = { web_sessions: number };

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
): Promise<SessionRevocationCounts> {
  assertDiscordId(discordId);
  if (opts.dryRun) return countActiveMemberSessions(sql, discordId);
  return sql.begin(async (tx) => {
    let revoked = 0;
    // An in-flight rotation can replace a locked row after this UPDATE's
    // statement snapshot. Recount with a fresh snapshot and catch its successor.
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await tx`update web_sessions
        set revoked_at = clock_timestamp()
        where user_id = ${discordId} and revoked_at is null and expires_at > clock_timestamp()
        returning 1`;
      revoked += rows.length;
      const remaining = await countActiveMemberSessions(tx, discordId);
      if (remaining.web_sessions === 0) return { web_sessions: revoked };
    }
    throw new Error("Active sessions kept changing during revocation.");
  });
}
