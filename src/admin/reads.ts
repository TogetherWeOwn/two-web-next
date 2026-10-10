// Admin read surfaces (W12: M6 roster, M8 join viewer + funnel stats).
// Read-only by construction: nothing here inserts, updates or deletes.

import { and, asc, count, desc, eq, gte, ilike, or, type SQL } from "drizzle-orm";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  JOIN_ATTEMPT_PAGE_SIZE,
  ROSTER_PAGE_SIZE,
  parseActivityLogQuery,
  parseJoinAttemptsQuery,
  type RosterQuery,
} from "./table-list";
import { escapeLikeTerm } from "../islands/contracts";
import type { Db } from "../db/index";
import { activityLog, events, rsvps } from "../db/admin-schema";
import { joinAttempts, users } from "../db/schema";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../jobs/constants";
import { declareMemberResult, keyedMemberRead, nonSensitiveRead } from "../member-reads";

/** config/join.php retention: attempts older than this are pruned (W13 cron). Canonical value lives in jobs/constants (legacy parity pin). */
export const JOIN_RETENTION_DAYS = JOIN_ATTEMPT_RETENTION_DAYS;

export type RosterEntry = {
  userId: string;
  username: string | null;
  status: string;
  answeredAt: Date;
};

/** Paged read-only RSVP roster for one event; most recent first unless explicitly sorted.
 *
 * Search and sort apply before paging, so `total` is the filtered count and
 * `rows` is one page of it. The deterministic `rsvps.userId` tie-break is kept.
 * A page past the end returns no rows (with working navigation); callers render
 * the past-end copy. The count is a classified aggregate: it returns only a
 * number, never member identifiers.
 */
export async function listRoster(
  db: Db,
  eventKey: string,
  query: RosterQuery = { q: "", sort: "answered", order: "desc", page: 1 },
): Promise<{ rows: RosterEntry[]; total: number }> {
  const page = Number.isSafeInteger(query.page) && query.page > 0 ? query.page : 1;
  const search: SQL | undefined = query.q
    ? ilike(users.username, `%${escapeLikeTerm(query.q)}%`)
    : undefined;
  const conds = search ? and(eq(events.eventKey, eventKey), search) : eq(events.eventKey, eventKey);
  const column = query.sort === "status" ? rsvps.status : rsvps.updatedAt;
  const order = query.order === "asc" ? asc(column) : desc(column);
  const countRows = await nonSensitiveRead("roster-count", () => {
    const counted = db
      .select({ n: count() })
      .from(rsvps)
      .innerJoin(events, eq(events.id, rsvps.eventId));
    return search
      ? counted.leftJoin(users, eq(users.id, rsvps.userId)).where(conds)
      : counted.where(conds);
  });
  const rows = await keyedMemberRead(() =>
    db
      .select({
        userId: rsvps.userId,
        memberId: users.id,
        username: users.username,
        status: rsvps.status,
        answeredAt: rsvps.updatedAt,
      })
      .from(rsvps)
      .innerJoin(events, eq(events.id, rsvps.eventId))
      .leftJoin(users, eq(users.id, rsvps.userId))
      .where(conds)
      .orderBy(order, rsvps.userId)
      .limit(ROSTER_PAGE_SIZE)
      .offset((page - 1) * ROSTER_PAGE_SIZE),
  );
  return { rows, total: Number(countRows[0]?.n ?? 0) };
}

// Explicit projection works on both migrateJoin() bootstrap and imported
// schemas. The actual attempt's discord_id owns these contents; looking up a
// current users row would lose attribution for members who have left.
export type JoinAttemptRow = Pick<
  typeof joinAttempts.$inferSelect,
  "id" | "outcome" | "source" | "requestId" | "discordId" | "createdAt"
>;
const attemptColumns = {
  id: joinAttempts.id,
  outcome: joinAttempts.outcome,
  source: joinAttempts.source,
  requestId: joinAttempts.requestId,
  discordId: joinAttempts.discordId,
  createdAt: joinAttempts.createdAt,
};

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
  if (opts.q)
    conds.push(or(eq(joinAttempts.discordId, opts.q), eq(joinAttempts.requestId, opts.q))!);
  return keyedMemberRead(() =>
    db
      .select(attemptColumns)
      .from(joinAttempts)
      .where(and(...conds))
      .orderBy(desc(joinAttempts.createdAt), desc(joinAttempts.id))
      // The lookahead powers Next and is still a sensitive read: capture its owner.
      .limit(JOIN_ATTEMPT_PAGE_SIZE + 1)
      .offset((page - 1) * JOIN_ATTEMPT_PAGE_SIZE),
  );
}

/** Direct lookup uses the list's retention window and the retrieved owner key. */
export async function getJoinAttempt(db: Db, id: number, now?: Date) {
  const [attempt] = await keyedMemberRead(() =>
    db
      .select(attemptColumns)
      .from(joinAttempts)
      .where(and(eq(joinAttempts.id, id), gte(joinAttempts.createdAt, windowStart(now))))
      .limit(1),
  );
  return attempt ? { attempt, memberId: attempt.discordId } : null;
}

function windowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - JOIN_RETENTION_DAYS * 86_400_000);
}

/** JoinFunnelStats: per-outcome counts over the retention window. Outcomes only, no member data.
 * `Pick<Db, "select">` so the dashboard wrapper can run it inside a bounded transaction. */
export async function joinFunnelStats(
  db: Pick<Db, "select">,
  now?: Date,
): Promise<Record<string, number>> {
  const rows = await nonSensitiveRead("join-funnel", () =>
    db
      .select({ outcome: joinAttempts.outcome, n: count() })
      .from(joinAttempts)
      .where(gte(joinAttempts.createdAt, windowStart(now)))
      .groupBy(joinAttempts.outcome),
  );
  const out: Record<string, number> = {};
  for (const r of rows.sort((a, b) => a.outcome.localeCompare(b.outcome)))
    out[r.outcome] = Number(r.n);
  return out;
}

// Read-only activity-log viewer (R11). The projection deliberately excludes
// `properties`: the dirty before/after map is never selected, so it cannot be
// rendered, and the read classifier refuses any statement that mentions it.
export type ActivityLogViewerRow = Pick<
  typeof activityLog.$inferSelect,
  "id" | "description" | "subjectType" | "subjectId" | "causerId" | "event" | "createdAt"
>;
const activityLogColumns = {
  id: activityLog.id,
  description: activityLog.description,
  subjectType: activityLog.subjectType,
  subjectId: activityLog.subjectId,
  causerId: activityLog.causerId,
  event: activityLog.event,
  createdAt: activityLog.createdAt,
};

/**
 * Paginated activity rows, newest first. `subject` matches the subject
 * type/id or description (substring); `causer` matches the causer snowflake
 * (substring). The retrieved causer snowflakes are the access-log subjects:
 * a page that names moderators writes one access-log row, and a failed
 * access-log write fails closed in the guard's boundary. System rows with a
 * null/non-snowflake causer contribute no subject, like pre-identity join
 * attempts. Imported rows keep legacy internal causer IDs (docs/data-import.md):
 * they render with an explicit legacy label and never become access-log
 * subjects, because the guard only accepts snowflakes and inventing a member
 * subject would be worse than logging none.
 */
export async function listActivityLog(
  db: Db,
  opts: { subject?: string; causer?: string; page?: number },
): Promise<ActivityLogViewerRow[]> {
  const parsed = parseActivityLogQuery({
    subject: opts.subject,
    causer: opts.causer,
    page: String(opts.page ?? 1),
  });
  const conds: SQL[] = [];
  if (parsed.subject) {
    const term = `%${escapeLikeTerm(parsed.subject)}%`;
    conds.push(
      or(
        ilike(activityLog.subjectType, term),
        ilike(activityLog.subjectId, term),
        ilike(activityLog.description, term),
      )!,
    );
  }
  if (parsed.causer) conds.push(ilike(activityLog.causerId, `%${escapeLikeTerm(parsed.causer)}%`));
  const rows = await nonSensitiveRead("activity-log", () =>
    db
      .select(activityLogColumns)
      .from(activityLog)
      .where(and(...conds))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(ACTIVITY_LOG_PAGE_SIZE + 1)
      .offset((parsed.page - 1) * ACTIVITY_LOG_PAGE_SIZE),
  );
  // Only well-formed snowflakes become subjects; nulls (cron) and malformed
  // values never reach the access log as invented members.
  declareMemberResult(
    rows.flatMap((r) =>
      r.causerId !== null && /^\d{10,25}$/.test(r.causerId) ? [r.causerId] : [],
    ),
  );
  return rows;
}
