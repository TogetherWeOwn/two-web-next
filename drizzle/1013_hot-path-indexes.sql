-- Preserve the legacy names so an imported schema keeps its existing indexes.
CREATE INDEX IF NOT EXISTS "rsvps_event_id_status_index" ON "rsvps" ("event_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rsvps_unsynced_event_id_index" ON "rsvps" ("event_id") WHERE synced_to_discord_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_ends_at_index" ON "events" ("ends_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_starts_at_id_index" ON "events" ("starts_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_attempts_outcome_index" ON "join_attempts" ("outcome");
