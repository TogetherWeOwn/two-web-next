import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// First data slice (W3): Discord users who have signed in. Sessions stay in
// signed cookies; this table is the durable roster (member = in the TWO guild
// at last sign-in). Migrations run against agent-testdb until Neon exists (S1).
export const users = pgTable("users", {
  // Discord user id (snowflake). Stable and globally unique: natural primary key.
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  avatar: text("avatar"),
  member: boolean("member").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
