import { sql } from "drizzle-orm";
import type { Db } from "../db/index";

export type Milestone = { type: string; occurredAt: Date; detail: string | null };
export type MemberStats = {
  joinedAt: Date | null;
  tenureDays: number | null;
  rankKey: string | null;
  isCurrentMember: boolean;
  milestones: Milestone[];
};
export type MemberStatsSource = (id: string, signal: AbortSignal) => Promise<MemberStats | null>;
export const MEMBER_STATS_BUDGET_MS = 500;

// One budget for connection setup and both optional reads, not one per query.
export async function memberStatsWithBudget(source: MemberStatsSource, id: string): Promise<MemberStats | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, MEMBER_STATS_BUDGET_MS);
  });
  try {
    return await Promise.race([source(id, controller.signal), expired]);
  } catch {
    console.warn("Member stats unavailable; hiding the stats block.");
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Only a dedicated stats client belongs here: force-closing it on expiry
// cancels in-flight SQL and connection attempts without touching the audit DB.
export async function readOwnedMemberStats(db: Pick<Db, "execute" | "$client">, id: string, signal: AbortSignal): Promise<MemberStats | null> {
  let closing: Promise<void> | undefined;
  const close = () => { closing ??= db.$client.end({ timeout: 0 }).catch(() => {}); };
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

const stringOrNull = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
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
export async function readMemberStats(db: Pick<Db, "execute"> | null, id: string, signal?: AbortSignal): Promise<MemberStats | null> {
  if (!db) return null;
  if (!signal) return memberStatsWithBudget((memberId, budget) => readMemberStats(db, memberId, budget), id);
  try {
    signal.throwIfAborted();
    const members = await db.execute(sql`
      select member_id, joined_at, tenure_days, rank_key, is_current_member
      from web_v1.members where member_id = ${id} limit 1
    `);
    signal.throwIfAborted();
    const member = members[0];
    if (!member) return null;
    const rows = await db.execute(sql`
      select milestone, occurred_at, detail from web_v1.member_milestones
      where member_id = ${id} order by occurred_at desc
    `);
    signal.throwIfAborted();
    return {
      joinedAt: dateOrNull(member.joined_at),
      tenureDays: daysOrNull(member.tenure_days),
      rankKey: stringOrNull(member.rank_key),
      isCurrentMember: member.is_current_member !== false,
      milestones: rows.flatMap((row) => {
        const occurredAt = dateOrNull(row.occurred_at);
        return occurredAt ? [{ type: stringOrNull(row.milestone) ?? "Milestone", occurredAt, detail: stringOrNull(row.detail) }] : [];
      }),
    };
  } catch {
    console.warn("Member stats unavailable; hiding the stats block.");
    return null;
  }
}
