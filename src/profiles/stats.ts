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
export type MemberStatsSource = (id: string) => Promise<MemberStats | null>;

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
export async function readMemberStats(db: Pick<Db, "execute"> | null, id: string): Promise<MemberStats | null> {
  if (!db) return null;
  try {
    const members = await db.execute(sql`
      select member_id, joined_at, tenure_days, rank_key, is_current_member
      from web_v1.members where member_id = ${id} limit 1
    `);
    const member = members[0];
    if (!member) return null;
    const rows = await db.execute(sql`
      select milestone, occurred_at, detail from web_v1.member_milestones
      where member_id = ${id} order by occurred_at desc
    `);
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
