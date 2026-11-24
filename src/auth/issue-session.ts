import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { enableAuthStatus } from "../auth-status";
import { databaseOptions, databaseUrl } from "../db/connection";
import { upsertRosterUser } from "../db/roster";
import type { Env } from "../env";
import { issueSession as persistSession } from "../http/session";
import { SESSION_COOKIE } from "../session-cookie";
import {
  type DbSessionRow,
  hashToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
  type Sql,
} from "../sessions";

// Fixture-only roster store. Deployed bindings do not set it.
type EnvWithRoster = Env & { ROSTER_STORE?: Sql };

// Roster persistence shares storeFor's DB selection so signed-in profiles
// read the same users sign-in writes. Tests may inject ROSTER_STORE; no DB
// configuration means a no-op upsert so DB-free sign-in tests still work.
// The users table is drizzle/0000, owned by
// the migrate workflow.
function rosterSqlFor(c: Context<{ Bindings: Env }>): {
  sql: Sql | null;
  close?: () => Promise<void>;
} {
  const injected = (c.env as EnvWithRoster).ROSTER_STORE;
  if (injected) return { sql: injected };
  const url = databaseUrl(c.env);
  if (!url) return { sql: null };
  // Bare options: this client feeds upsertRosterUser only, whose
  // transaction already installs a tighter 500 ms SET LOCAL bound.
  const client = postgres(url, databaseOptions);
  return {
    sql: client as unknown as Sql,
    close: () => client.end({ timeout: 0 }),
  };
}

export async function issueSession(
  c: Context<{ Bindings: Env }>,
  store: SessionStore,
  row: DbSessionRow,
): Promise<void> {
  // Discord login, join and staging QA refresh the same durable roster row.
  // Roster failure warns and sign-in still issues. The moderator bit lives
  // only in the session row and comes from Discord role IDs.
  try {
    const roster = rosterSqlFor(c);
    try {
      await upsertRosterUser(roster.sql, {
        id: row.userId,
        username: row.username,
        avatar: row.avatar,
        member: row.member,
      });
    } finally {
      // Dedicated optional client only: never close injected/shared or session
      // storage. SQL limits cancel backend work; end also settles pending I/O.
      await roster.close?.();
    }
  } catch (err) {
    // Driver messages can carry DSN fragments; the class name is the whole story here.
    console.warn("roster upsert failed", {
      request_id: c.get("requestId"),
      exception: (err as Error)?.constructor?.name ?? "unknown",
    });
  }
  const token = await persistSession(store, row, {
    readPriorToken: () => getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE),
    warnSweepFailure: (err) => {
      console.warn("prior session sweep failed", {
        request_id: c.get("requestId"),
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
    },
  });
  await setSignedCookie(c, SESSION_COOKIE, token, c.env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  await enableAuthStatus(c, store, await hashToken(token));
}
