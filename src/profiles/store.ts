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
            joinedAt: users.createdAt,
          })
          .from(users)
          .leftJoin(profiles, eq(profiles.userId, users.id))
          .where(eq(users.id, id))
          .limit(1),
      );
      const r = rows[0];
      return r ? { ...r, games: r.games ?? [] } : null;
    },
    async save(id, attrs) {
      await db
        .insert(profiles)
        .values({ userId: id, ...attrs })
        .onConflictDoUpdate({ target: profiles.userId, set: { ...attrs, updatedAt: sql`now()` } });
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
      const m = rows.get(id);
      if (m) rows.set(id, { ...m, ...attrs });
    },
  };
}
