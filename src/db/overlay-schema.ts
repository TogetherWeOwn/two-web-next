// Migration metadata for the raw-SQL overlay store. Keep this separate from
// schema.ts: admin/db spreads that namespace into every page database, but no
// page reads these tables in this slice. drizzle.config.ts includes both.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Per-member OBS overlay page: config + token lifecycle. Config rows are
// member-written and survive Discord sync (same reasoning as profiles.user_id:
// the roster upsert is best-effort, so member_id carries no FK). Token rows
// are append-mostly history: lifecycle ops flip status, never delete. The
// retention prune removes aged non-live rows; member erasure removes all states.
export const overlayConfigs = pgTable("overlay_configs", {
  memberId: text("member_id").primaryKey(),
  elements: jsonb("elements").notNull().$type<Record<string, unknown>>().default({}),
  theme: jsonb("theme").notNull().$type<Record<string, unknown>>().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const overlayTokens = pgTable(
  "overlay_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: text("member_id").notNull(),
    // SHA-256 hex of the bearer. Plaintext exists only in the one-time
    // creation response; nothing here can mint a working overlay URL.
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: bigint("use_count", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    check(
      "overlay_tokens_status_check",
      sql`${t.status} IN ('live', 'rotated', 'revoked', 'expired')`,
    ),
    index("overlay_tokens_member_idx").on(t.memberId, t.status),
    // One live token per member, enforced at the row level so concurrent
    // mints cannot both win. Rotation updates the predecessor before the
    // successor insert lands, so it never trips this.
    uniqueIndex("overlay_tokens_member_live_unique")
      .on(t.memberId)
      .where(sql`${t.status} = 'live'`),
  ],
);
