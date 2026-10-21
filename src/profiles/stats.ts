import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { keyedMemberRead } from "../member-reads";
import { memberReadDb } from "../db/member-reads";

export type Milestone = { type: string; occurredAt: Date; detail: string | null };
export type MemberStats = {
  joinedAt: Date | null;
  tenureDays: number | null;
  rankKey: string | null;
  isCurrentMember: boolean;
  milestones: Milestone[];
  milestonesTruncated: boolean;
  /** Membership read failed: no fact on this object is valid; render unavailable. */
  membershipUnavailable?: boolean;
  /** Milestones read failed: membership facts are valid; milestones read as unavailable. */
  milestonesUnavailable?: boolean;
};
export type MemberStatsSource = (id: string, signal: AbortSignal) => Promise<MemberStats | null>;
export const MEMBER_STATS_BUDGET_MS = 500;
// Newest-N milestone window: the SQL read is capped at this many rows so one
// member cannot force an unbounded scan. Matches the sibling 100-row caps.
export const MEMBER_MILESTONES_CAP = 100;

// Membership unknown: every fact reads null and the twins render the
// unavailable state instead of the stats grid. isCurrentMember is a
// placeholder the renderers never read on this path, so it invents nothing.
const statsUnavailable = (): MemberStats => ({
  joinedAt: null,
  tenureDays: null,
  rankKey: null,
  isCurrentMember: false,
  milestones: [],
  milestonesTruncated: false,
  membershipUnavailable: true,
});

// A budget trip settles a hung optional read instead of hanging the source:
// the wait rejects with the abort reason synchronously inside the abort
// dispatch, so a borrowed query still in flight reports the timeout while a
// query that already settled keeps its natural outcome. Late settlements and
// rejections are observed and discarded, never unhandled and never rewriting
// the decided outcome.
const abortableQuery = <T>(signal: AbortSignal, query: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    query.then(
      (rows) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        resolve(rows);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });

// One budget for connection setup and both optional reads, not one per query.
// The budget aborts; the source decides: expiry trips the signal and the
// source settles its timeout outcome (partial facts or unavailable), so no
// race can discard a membership the source already holds. Sources must settle
// promptly after abort — the readers below do via abortableQuery.
export async function memberStatsWithBudget(
  source: MemberStatsSource,
  id: string,
): Promise<MemberStats | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMBER_STATS_BUDGET_MS);
  try {
    return await source(id, controller.signal);
  } catch {
    console.warn("Member stats unavailable; showing the unavailable state.");
    return statsUnavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Only a dedicated stats client belongs here: force-closing it on expiry
// cancels in-flight SQL and connection attempts without touching the audit DB.
export async function readOwnedMemberStats(
  db: Pick<Db, "execute" | "$client">,
  id: string,
  signal: AbortSignal,
): Promise<MemberStats | null> {
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= db.$client.end({ timeout: 0 }).catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    return await readMemberStats(db, id, signal);
  } finally {
    signal.removeEventListener("abort", close);
    close();
    await closing;
  }
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const dateOrNull = (value: unknown): Date | null => {
  if (!(value instanceof Date) && (typeof value !== "string" || value === "")) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};
const daysOrNull = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 0 ? days : null;
};

// Bot-owned views are optional. Never include an exception message in logs:
// database errors can carry connection strings or member data.
export async function readMemberStats(
  db: Pick<Db, "execute"> | null,
  id: string,
  signal?: AbortSignal,
): Promise<MemberStats | null> {
  if (!db) return null;
  if (!signal)
    return memberStatsWithBudget((memberId, budget) => readMemberStats(db, memberId, budget), id);
  const connection = memberReadDb(db as Db);
  try {
    signal.throwIfAborted();
    const members = await abortableQuery(
      signal,
      keyedMemberRead(() =>
        connection.execute(sql`
      select member_id, joined_at, tenure_days, rank_key, is_current_member
      from web_v1.members where member_id = ${id} limit 1
    `),
      ),
    );
    signal.throwIfAborted();
    const member = members[0];
    if (!member) return null;
    const membership = {
      joinedAt: dateOrNull(member.joined_at),
      tenureDays: daysOrNull(member.tenure_days),
      rankKey: stringOrNull(member.rank_key),
      isCurrentMember: member.is_current_member !== false,
    };
    signal.throwIfAborted();
    try {
      // Read one row past the display cap: the extra row only detects
      // truncation, so the count never silently reports the cap as a total.
      const rows = await abortableQuery(
        signal,
        keyedMemberRead(() =>
          connection.execute(sql`
          select member_id, milestone, occurred_at, detail from web_v1.member_milestones
          where member_id = ${id} order by occurred_at desc, milestone asc, detail asc nulls last
          limit ${sql.raw(String(MEMBER_MILESTONES_CAP + 1))}
        `),
        ),
      );
      signal.throwIfAborted();
      const truncated = rows.length > MEMBER_MILESTONES_CAP;
      const capped = truncated ? rows.slice(0, MEMBER_MILESTONES_CAP) : rows;
      return {
        ...membership,
        milestonesTruncated: truncated,
        milestones: capped.flatMap((row) => {
          const occurredAt = dateOrNull(row.occurred_at);
          return occurredAt
            ? [
                {
                  type: stringOrNull(row.milestone) ?? "Milestone",
                  occurredAt,
                  detail: stringOrNull(row.detail),
                },
              ]
            : [];
        }),
      };
    } catch {
      // Milestones are optional: a missing view, a failed query, or a budget
      // trip that destroys the owned client keeps the membership facts and
      // reads the milestones as unavailable, never as an empty list.
      console.warn("Member milestones unavailable; keeping membership facts.");
      return {
        ...membership,
        milestones: [],
        milestonesTruncated: false,
        milestonesUnavailable: true,
      };
    }
  } catch {
    console.warn("Member stats unavailable; showing the unavailable state.");
    return statsUnavailable();
  }
}
