import { bigserial, boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

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

// W6: one row per terminal join path (ports two-web JoinController::recordAttempt, TOG-5617).
// Only the four safe columns ever reach the table: outcome, source, request_id,
// discord_id. The member OAuth token lives in the signed bot request body and the
// stack frame only — never a parameter here, so it can never end up in the row.
// The token-hygiene test (test/join.test.ts) pins this: a full join round trip
// with a known token leaves no trace of it in any table.
export const joinAttempts = pgTable(
  "join_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    source: varchar("source", { length: 64 }),
    requestId: text("request_id"),
    discordId: text("discord_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("join_attempts_created_at_idx").on(t.createdAt)],
);

export type JoinAttempt = typeof joinAttempts.$inferSelect;
export type NewJoinAttempt = typeof joinAttempts.$inferInsert;

// W6: throttle hits for the join journey (ports the `throttle:10,1` middleware on
// legacy /join/discord + /join/callback). Same shape as agent_event_hits: one row
// per counted request, the budget is the rows in the last 60 s. Never holds tokens,
// user ids or anything but the bucket name — the token-hygiene scan covers it too.
export const webThrottleHits = pgTable(
  "web_throttle_hits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bucket: text("bucket").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("web_throttle_hits_bucket_at_idx").on(t.bucket, t.at)],
);

// W14: scoped machine ingress for agent-originated events (ports two-web TOG-5510 Gate 2).
// Tables mirror two-web's agent_event_* migration; `agent_events` is the minimal proof-event
// table these five operations act on until the events slice lands.
export const agentEventGrants = pgTable(
  "agent_event_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    companyId: text("company_id").notNull(),
    guildId: text("guild_id").notNull(),
    // SHA-256 hex of the opaque credential: the credential alone identifies the grant.
    verifierHash: varchar("verifier_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_event_grants_agent_id_idx").on(t.agentId)],
);

export const agentEventIdempotencyKeys = pgTable(
  "agent_event_idempotency_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => agentEventGrants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    status: smallint("status").notNull(),
    body: jsonb("body").notNull(),
    eventKey: varchar("event_key", { length: 26 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The replay store is unique on (grant, key); rows are never deleted by the request path.
  (t) => [unique("agent_event_idempotency_grant_key").on(t.grantId, t.key)],
);

export const agentEventAudits = pgTable(
  "agent_event_audits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    grantId: uuid("grant_id").references(() => agentEventGrants.id, { onDelete: "set null" }),
    operation: varchar("operation", { length: 32 }).notNull(),
    eventKey: varchar("event_key", { length: 26 }),
    idempotencyKey: text("idempotency_key"),
    payloadDigest: varchar("payload_digest", { length: 64 }),
    requestId: text("request_id").notNull(),
    result: varchar("result", { length: 16 }).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_event_audits_grant_created_idx").on(t.grantId, t.createdAt), index("agent_event_audits_event_key_idx").on(t.eventKey)],
);

// One row per counted (non-replay) request; the budget is the rows in the last 60 s.
export const agentEventHits = pgTable(
  "agent_event_hits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bucket: text("bucket").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_event_hits_bucket_at_idx").on(t.bucket, t.at)],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    eventKey: varchar("event_key", { length: 26 }).primaryKey(),
    // One proof event per grant, enforced by the database (the quota backstop under concurrency).
    agentGrantId: uuid("agent_grant_id")
      .notNull()
      .unique()
      .references(() => agentEventGrants.id, { onDelete: "cascade" }),
    proofMarker: text("proof_marker").notNull().unique(),
    // Optimistic-concurrency counter, bumped only by agent writes.
    agentVersion: integer("agent_version").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    title: varchar("title", { length: 100 }).notNull(),
    game: varchar("game", { length: 100 }),
    description: varchar("description", { length: 1000 }),
    // Naive local wall times ("YYYY-MM-DD HH:MM") interpreted in `timezone`.
    startsAt: varchar("starts_at", { length: 16 }).notNull(),
    endsAt: varchar("ends_at", { length: 16 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    location: varchar("location", { length: 255 }).notNull(),
    capacity: integer("capacity"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

// W7: member-authored profile (ports two-web `profiles`). Split from `users` on
// purpose: `users` is overwritten from Discord on every sign-in, this row is
// written by the member and must survive that sync. user_id is the Discord
// snowflake, plain text with no FK (same reasoning as rsvps.user_id: the roster
// upsert is best-effort, so an FK would reject a legitimate save).
export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey(),
  bio: text("bio"),
  games: jsonb("games").notNull().$type<string[]>().default([]),
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProfileRow = typeof profiles.$inferSelect;
