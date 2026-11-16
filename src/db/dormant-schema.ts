import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { events } from "./admin-schema";

export const eventEchoes = pgTable(
  "event_echoes",
  {
    id: serial("id").primaryKey(),
    // One Echo per event; re-pulls before publication replace the row, never
    // append a second one. Cascade keeps erasure of an event total.
    eventId: integer("event_id")
      .notNull()
      .unique()
      .references(() => events.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    // Bot-observed window the payload was stamped with (event window ±15 min).
    windowStartsAt: timestamp("window_starts_at", { withTimezone: true }).notNull(),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
    // Attendance threshold carried in the payload (≥N minutes = attended).
    // Stored so a future threshold change never silently rewrites old Echoes.
    thresholdMinutes: integer("threshold_minutes").notNull(),
    // Frozen bot-owned facts: peak concurrent (bots/AFK excluded), attended
    // count (minutes ≥ threshold), rooms as [{channel_id, name_at_close}].
    peakConcurrent: integer("peak_concurrent").notNull(),
    attendedCount: integer("attended_count").notNull(),
    rooms: jsonb("rooms").notNull().$type<{ channel_id: string; name_at_close: string }[]>(),
    // The one host-editable field. Null renders the generated counts line.
    headline: text("headline"),
    // Discord thread-post outcome: set when the announcement.post retry
    // succeeds. The Echo stands on the site even when the post is pending.
    announcementPostedAt: timestamp("announcement_posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("event_echoes_event_key_idx").on(t.eventKey),
    index("event_echoes_created_at_idx").on(t.createdAt),
    check("event_echoes_threshold_positive", sql`${t.thresholdMinutes} > 0`),
    check(
      "event_echoes_counts_frozen_nonnegative",
      sql`${t.peakConcurrent} >= 0 AND ${t.attendedCount} >= 0`,
    ),
    check("event_echoes_window_ordered", sql`${t.windowEndsAt} > ${t.windowStartsAt}`),
  ],
);

// Dormant per-member attendance storage. Feature activation must provide
// access controls and member erasure before any personal data is written.
export const eventEchoMembers = pgTable(
  "event_echo_members",
  {
    id: serial("id").primaryKey(),
    echoId: integer("echo_id")
      .notNull()
      .references(() => eventEchoes.id, { onDelete: "cascade" }),
    // Discord snowflake, plain text like rsvps.user_id (no FK to users: the
    // roster upsert is best-effort, same reasoning as rsvps).
    userId: text("user_id").notNull(),
    minutes: integer("minutes").notNull(),
    sessions: integer("sessions").notNull(),
    firstJoinedAt: timestamp("first_joined_at", { withTimezone: true }),
  },
  (t) => [
    unique("event_echo_members_echo_user_unique").on(t.echoId, t.userId),
    index("event_echo_members_user_id_idx").on(t.userId),
    check("event_echo_members_minutes_nonnegative", sql`${t.minutes} >= 0`),
    check("event_echo_members_sessions_positive", sql`${t.sessions} >= 1`),
  ],
);
