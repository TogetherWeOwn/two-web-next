ALTER TABLE "events" ADD COLUMN "discord_sync_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "discord_sync_failure_code" text;