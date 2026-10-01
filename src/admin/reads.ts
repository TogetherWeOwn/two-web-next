// Admin read surfaces (W12: M6 roster, M8 join viewer + funnel stats).
// Read-only by construction: nothing here inserts, updates or deletes.

import { and, asc, count, desc, eq, gte, ilike, or } from "drizzle-orm";
import { JOIN_ATTEMPT_PAGE_SIZE, parseJoinAttemptsQuery, type RosterQuery } from "./table-list";
import { escapeLikeTerm } from "../islands/contracts";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { joinAttempts, users } from "../db/schema";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../jobs/constants";

/** config/join.php retention: attempts older than this are pruned (W13 cron). Canonical value lives in jobs/constants (legacy parity pin). */
export const JOIN_RETENTION_DAYS = JOIN_ATTEMPT_RETENTION_DAYS;

export type RosterEntry = { userId: string; username: string | null; status: string; answeredAt: Date };

/** Read-only RSVP roster for one event; most recent first unless explicitly sorted. */
export async function listRoster(
  db: Db,
  eventKey: string,
  query: RosterQuery = { q: "", sort: "answered", order: "desc" },
): Promise<RosterEntry[]> {
  const conds = [eq(events.eventKey, eventKey)];
  if (query.q) conds.push(ilike(users.username, `%${escapeLikeTerm(query.q)}%`));
  const column = query.sort === "status" ? rsvps.status : rsvps.updatedAt;
  const order = query.order === "asc" ? asc(column) : desc(column);
  const rows = await db
    .select({ userId: rsvps.userId, username: users.username, status: rsvps.status, answeredAt: rsvps.updatedAt })
    .from(rsvps)
    .innerJoin(events, eq(events.id, rsvps.eventId))
    .leftJoin(users, eq(users.id, rsvps.userId))
    .where(and(...conds))
    .orderBy(order, rsvps.userId);
  return rows;
}

// Viewer shape excludes the import-only legacy_id key: fresh staging
// databases bootstrapped by migrateJoin() (drizzle/1000 shape) have no such
// column, and SELECT * would fail there with 42703. Explicit columns keep the
// viewer readable on both the bootstrap and migrated (drizzle/1012) shapes.
export type JoinAttemptRow = Pick<
  typeof joinAttempts.$inferSelect,
  "id" | "outcome" | "source" | "requestId" | "discordId" | "createdAt"
>;

/**
 * Viewer over the write-once trail, newest first, inside the retention
 * window. `q` is an EXACT match on discord_id or request_id (the bot-log
 * cross-reference) — never a substring scan over member ids.
 */
export async function listJoinAttempts(
  db: Db,
  opts: { outcome?: string; q?: string; page?: number; now?: Date },
): Promise<JoinAttemptRow[]> {
  const { page } = parseJoinAttemptsQuery({ page: String(opts.page ?? 1) });
  const since = windowStart(opts.now);
  const conds = [gte(joinAttempts.createdAt, since)];
  if (opts.outcome) conds.push(eq(joinAttempts.outcome, opts.outcome));
  if (opts.q) conds.push(or(eq(joinAttempts.discordId, opts.q), eq(joinAttempts.requestId, opts.q))!);
  return db
    .select({
      id: joinAttempts.id,
      outcome: joinAttempts.outcome,
      source: joinAttempts.source,
      requestId: joinAttempts.requestId,
      discordId: joinAttempts.discordId,
      createdAt: joinAttempts.createdAt,
    })
    .from(joinAttempts)
    .where(and(...conds))
    .orderBy(desc(joinAttempts.createdAt), desc(joinAttempts.id))
    // One lookahead row powers Next; routes render and audit only this page.
    .limit(JOIN_ATTEMPT_PAGE_SIZE + 1)
    .offset((page - 1) * JOIN_ATTEMPT_PAGE_SIZE);
}

/** Direct lookup uses the list's retention window; mapped identities remain audit subjects after leaving. */
export async function getJoinAttempt(db: Db, id: number, now?: Date) {
  // Same explicit projection as the list: a bare `attempt: joinAttempts`
  // expands to SELECT * including legacy_id and 42703s on migrateJoin()
  // bootstraps (drizzle/1000 shape). The joined member id stays.
  const [row] = await db
    .select({
      attempt: {
        id: joinAttempts.id,
        outcome: joinAttempts.outcome,
        source: joinAttempts.source,
        requestId: joinAttempts.requestId,
        discordId: joinAttempts.discordId,
        createdAt: joinAttempts.createdAt,
      },
      memberId: users.id,
    })
    .from(joinAttempts)
    .leftJoin(users, eq(users.id, joinAttempts.discordId))
    .where(and(eq(joinAttempts.id, id), gte(joinAttempts.createdAt, windowStart(now))))
    .limit(1);
  return row ?? null;
}

function windowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - JOIN_RETENTION_DAYS * 86_400_000);
}

/** JoinFunnelStats: per-outcome counts over the retention window. Outcomes only, no member data.
 * `Pick<Db, "select">` so the dashboard wrapper can run it inside a bounded transaction. */
export async function joinFunnelStats(db: Pick<Db, "select">, now?: Date): Promise<Record<string, number>> {
  const rows = await db
    .select({ outcome: joinAttempts.outcome, n: count() })
    .from(joinAttempts)
    .where(gte(joinAttempts.createdAt, windowStart(now)))
    .groupBy(joinAttempts.outcome);
  const out: Record<string, number> = {};
  for (const r of rows.sort((a, b) => a.outcome.localeCompare(b.outcome))) out[r.outcome] = Number(r.n);
  return out;
}
