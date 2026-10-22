import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { memberReadDb } from "../db/member-reads";
import { keyedMemberRead } from "../member-reads";
import { memberLinks } from "../db/schema";

export type MemberLink = { label: string; url: string };

export type LinksStore = {
  find: (userId: string) => Promise<MemberLink[] | null>;
  save: (userId: string, links: MemberLink[]) => Promise<void>;
};

export function createDbLinksStore(connection: Db): LinksStore {
  const db = memberReadDb(connection);
  return {
    async find(userId) {
      const rows = await keyedMemberRead(() =>
        db
          .select({ links: memberLinks.links })
          .from(memberLinks)
          .where(eq(memberLinks.userId, userId))
          .limit(1),
      );
      const row = rows[0];
      return row ? [...row.links] : null;
    },
    async save(userId, links) {
      const value = links.map((link) => ({ ...link }));
      await db
        .insert(memberLinks)
        .values({ userId, links: value })
        .onConflictDoUpdate({
          target: memberLinks.userId,
          set: { links: value, updatedAt: sql`now()` },
        });
    },
  };
}

/** Test double with the same contract. */
export function createMemoryLinksStore(
  seed: [string, MemberLink[]][] = [],
): LinksStore & { rows: Map<string, MemberLink[]> } {
  const rows = new Map(seed.map(([id, links]) => [id, links.map((link) => ({ ...link }))]));
  return {
    rows,
    async find(id) {
      const links = rows.get(id);
      return links ? links.map((link) => ({ ...link })) : null;
    },
    async save(id, links) {
      rows.set(
        id,
        links.map((link) => ({ ...link })),
      );
    },
  };
}
