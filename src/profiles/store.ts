import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { memberReadDb } from "../db/member-reads";
import { declareMemberResult, keyedMemberRead } from "../member-reads";
import { profiles, users } from "../db/schema";
import type { ProfileAttrs } from "./validation";

export type MemberView = {
  id: string;
  username: string;
  avatar: string | null;
  bio: string | null;
  games: string[];
  timezone: string | null;
  /** Absent in older seeds; read as opted in. */
  leaderboardOptOut?: boolean;
  joinedAt?: Date | null;
};

export type ProfileStore = {
  find: (id: string) => Promise<MemberView | null>;
  save: (id: string, attrs: ProfileAttrs) => Promise<void>;
};

export function createDbProfileStore(connection: Db): ProfileStore {
  const db = memberReadDb(connection);
  return {
    async find(id) {
      const rows = await keyedMemberRead(() =>
        db
          .select({
            id: users.id,
            profileUserId: profiles.userId,
            username: users.username,
            avatar: users.avatar,
            bio: profiles.bio,
            games: profiles.games,
            timezone: profiles.timezone,
            leaderboardOptOut: profiles.leaderboardOptOut,
            joinedAt: users.createdAt,
          })
          .from(users)
          .leftJoin(profiles, eq(profiles.userId, users.id))
          .where(eq(users.id, id))
          .limit(1),
      );
      const r = rows[0];
      // No profile row yet reads as opted in; the save upserts the row.
      return r
        ? { ...r, games: r.games ?? [], leaderboardOptOut: r.leaderboardOptOut ?? false }
        : null;
    },
    async save(id, attrs) {
      // An absent switch preserves the stored choice: only a named value moves
      // the column, so older clients can never silently opt a member back in.
      const optOut =
        attrs.leaderboardOptOut === undefined ? {} : { leaderboardOptOut: attrs.leaderboardOptOut };
      await db
        .insert(profiles)
        .values({
          userId: id,
          bio: attrs.bio,
          games: attrs.games,
          timezone: attrs.timezone,
          ...optOut,
        })
        .onConflictDoUpdate({
          target: profiles.userId,
          set: {
            bio: attrs.bio,
            games: attrs.games,
            timezone: attrs.timezone,
            updatedAt: sql`now()`,
            ...optOut,
          },
        });
    },
  };
}

/** Test double with the same contract. */
export function createMemoryProfileStore(
  seed: MemberView[] = [],
): ProfileStore & { rows: Map<string, MemberView> } {
  const rows = new Map(seed.map((m) => [m.id, m]));
  return {
    rows,
    async find(id) {
      const member = rows.get(id) ?? null;
      declareMemberResult(member ? [member.id] : []);
      return member;
    },
    async save(id, attrs) {
      // Mirror the Postgres upsert: a missing row is created, and an absent
      // switch preserves the stored choice.
      const m = rows.get(id);
      rows.set(id, {
        id,
        username: m?.username ?? id,
        avatar: m?.avatar ?? null,
        joinedAt: m?.joinedAt,
        bio: attrs.bio,
        games: attrs.games,
        timezone: attrs.timezone,
        leaderboardOptOut: attrs.leaderboardOptOut ?? m?.leaderboardOptOut ?? false,
      });
    },
  };
}
