import { boolean, index, integer, jsonb, pgTable, type AnyPgColumn, serial, text, timestamp } from "drizzle-orm/pg-core";

// Admin slice (W11). Ports the legacy two-web DDL the Filament panel ran on:
// events (+ corrections + recurrence + rsvp_open), featured_contents (+
// image_alt), member_data_access_logs, activity_log (spatie). RSVP/join tables
// belong to W8/W9 and W12 respectively and are NOT created here.
//
// Column-for-column notes where the port differs deliberately:
// - events.status is text (legacy cast to the EventStatus enum in PHP; the
//   transition guard lives in src/admin/validation.ts nextStatus()).
// - activity_log is the spatie shape minus the event/batch columns the legacy
//   app added but the admin rebuild never reads; subject/causer are stored as
//   type+id string pairs (nullableMorphs) rather than separate tables.
// - created_by / viewer_user_id are plain text (Discord snowflakes), NOT
//   foreign keys to users: main's login flow never maintains the users
//   roster, so an FK would reject every admin write with 23503. The W-auth
//   slice owns the roster question; this slice stores the snowflake.

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    // External key handed to the bot (bot keeps event_key -> discord_event_id
    // forever): ULID, unique, immutable — never the autoincrement id, or a
    // shared bot edits the wrong Discord event across environments.
    eventKey: text("event_key").notNull().unique(),
    title: text("title").notNull(),
    game: text("game"),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // IANA zone the host typed the wall time in. The instants above are the
    // truth; this is how they render back.
    timezone: text("timezone").notNull().default("UTC"),
    location: text("location"),
    capacity: integer("capacity"),
    status: text("status").notNull().default("draft"),
    discordEventId: text("discord_event_id").unique(),
    createdBy: text("created_by"),
    // Pause flag (TOG-8725): a published event stays visible while taking no
    // new answers. Default true so every row written by a caller that does
    // not know about the flag keeps today's behaviour: open.
    rsvpOpen: boolean("rsvp_open").notNull().default(true),
    // Series rule lives on the parent; children carry the pointer + index.
    // Parent is index 1, first materialised child is 2.
    recurrenceFrequency: text("recurrence_frequency"),
    recurrenceCount: integer("recurrence_count"),
    recurrenceEndsOn: timestamp("recurrence_ends_on"),
    // The self-reference needs the column type spelled out (drizzle self-FK
    // inference cycle — tsc rejects the bare `() => events.id` form).
    parentEventId: integer("parent_event_id").references((): AnyPgColumn => events.id, { onDelete: "set null" }),
    recurrenceIndex: integer("recurrence_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The calendar always asks the same question: published events, soonest first.
    index("events_status_starts_at_idx").on(t.status, t.startsAt),
    index("events_parent_event_id_idx").on(t.parentEventId),
  ],
);

export const featuredContents = pgTable(
  "featured_contents",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    imageUrl: text("image_url"),
    // Required when image_url is set (TOG-8707): an image with no description
    // is silent for screen-reader visitors.
    imageAlt: text("image_alt"),
    // Off = staged: visible in admin, not on the landing page.
    isPublished: boolean("is_published").notNull().default(false),
    // Lower numbers appear first.
    position: integer("position").notNull().default(0),
    // Optional show-window in UTC (legacy labels the fields "(UTC)").
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The landing page always asks the same question: published rows, in the
    // order the moderators arranged them.
    index("featured_contents_published_position_idx").on(t.isPublished, t.position),
  ],
);

// Who looked at member data through the admin panel, when, and at whose
// records (CISO condition TOG-355). Append-only: no UPDATE/DELETE path is
// offered by the store; retention pruning is a mass delete by age (W12 cron).
export const memberDataAccessLogs = pgTable(
  "member_data_access_logs",
  {
    id: serial("id").primaryKey(),
    // Discord snowflake as a string (never arithmetic); the literal
    // 'unauthenticated' marks the defect shape of a read with no viewer.
    viewerDiscordId: text("viewer_discord_id").notNull(),
    viewerUserId: text("viewer_user_id"),
    // Free-form strings on purpose: an enum would need a migration every
    // time the panel grows a screen. Evidence, not control flow.
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    // Internal users.id values only — never usernames, never contents.
    subjectUserIds: jsonb("subject_user_ids").notNull().$type<string[]>(),
    // Denormalised so "who read 400 records in one request" is a plain
    // ORDER BY rather than a jsonb_array_length scan.
    subjectCount: integer("subject_count").notNull(),
    // Route NAME, never the URL: a URL can carry a typed search term, and a
    // search term about a member is member data.
    route: text("route"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "What did this viewer look at, in this window?"
    index("member_access_viewer_occurred_idx").on(t.viewerDiscordId, t.occurredAt),
    // "What can we still see?" — also the column retention prunes on.
    index("member_access_occurred_idx").on(t.occurredAt),
    // "Who looked at *this member*?" — GIN over the jsonb id array.
    // NOTE: drizzle-kit emits a btree index for jsonb; the GIN
    // (jsonb_path_ops) index is created in the hand-written SQL below
    // (MIGRATION_SQL) because the legacy query needs it. W1 owns the
    // Hyperdrive→Neon GIN semantics proof; this keeps the DDL identical.
  ],
);

// Write audit trail (ports spatie LogsActivity dirty-only on Event +
// FeaturedContent). One row per save that changed something; bot-owned
// columns never land here. subjectType/subjectId + causerId mirror the
// nullableMorphs/causer shape; properties is the dirty {before,after} map.
export const activityLog = pgTable(
  "activity_log",
  {
    id: serial("id").primaryKey(),
    logName: text("log_name").notNull().default("default"),
    description: text("description").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    causerId: text("causer_id"),
    properties: jsonb("properties").$type<Record<string, { before: unknown; after: unknown }>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activity_log_log_name_idx").on(t.logName)],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type FeaturedContent = typeof featuredContents.$inferSelect;
export type NewFeaturedContent = typeof featuredContents.$inferInsert;
export type MemberDataAccessLog = typeof memberDataAccessLogs.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
