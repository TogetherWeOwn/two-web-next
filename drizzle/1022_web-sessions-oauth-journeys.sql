-- TOG-19721: session + journey tables move from runtime self-migration
-- (migrate() in src/sessions.ts, migrateOAuthJourneys() in
-- src/oauth-journeys.ts) into the migrate workflow, so the runtime role
-- returns to least privilege (read/write only, no schema CREATE).
-- IF NOT EXISTS throughout: live databases already carry these tables from
-- the retired runtime backstop, where this is a no-op; fresh databases gain
-- them here. Shape is identical to the retired runtime DDL.
CREATE TABLE IF NOT EXISTS "web_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"avatar" text,
	"member" boolean NOT NULL,
	"moderator" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"status_hash" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "web_oauth_journeys" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"flow" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "web_oauth_journeys_flow_check" CHECK ("web_oauth_journeys"."flow" IN ('auth', 'join'))
);
--> statement-breakpoint
-- Additive rollout (mirrors the retired runtime ALTER): a web_sessions table
-- that predates the status probe gains the column here, not per request.
ALTER TABLE "web_sessions" ADD COLUMN IF NOT EXISTS "status_hash" text;
--> statement-breakpoint
UPDATE "web_sessions" SET "status_hash" = "token_hash" WHERE "status_hash" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_oauth_journeys_expires_at_idx" ON "web_oauth_journeys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_sessions_status_hash_idx" ON "web_sessions" USING btree ("status_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_sessions_user_id_idx" ON "web_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_sessions_expires_at_idx" ON "web_sessions" USING btree ("expires_at");
