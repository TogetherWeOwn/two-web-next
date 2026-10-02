-- Apply with the ingress disabled and its old Worker drained. Drizzle runs this
-- migration transactionally: any key/marker collision aborts, never discards evidence.
ALTER TABLE "events" ADD COLUMN "agent_grant_id" uuid CONSTRAINT "events_agent_grant_id_agent_event_grants_id_fk" REFERENCES "agent_event_grants"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "proof_marker" text;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "agent_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_agent_grant_id_unique" UNIQUE ("agent_grant_id");
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_proof_marker_unique" UNIQUE ("proof_marker");
--> statement-breakpoint
-- The temporary table stored naive wall strings; the shared table stores instants.
-- AT TIME ZONE uses each row's own zone, independent of the session's TimeZone.
INSERT INTO "events" (event_key, agent_grant_id, proof_marker, agent_version,
                      title, game, description, starts_at, ends_at, timezone,
                      location, capacity, status, created_at, updated_at)
SELECT event_key, agent_grant_id, proof_marker, agent_version,
       title, game, description, starts_at::timestamp AT TIME ZONE timezone,
       ends_at::timestamp AT TIME ZONE timezone, timezone,
       location, capacity, status, created_at, updated_at
FROM "agent_events";
--> statement-breakpoint
-- All keys, markers, versions and audit/replay references survive in events.
-- No runtime may write the retired table after this migration.
DROP TABLE "agent_events";
