ALTER TABLE "activity_log" ALTER COLUMN "log_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_log" ALTER COLUMN "updated_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_event_audits" ADD COLUMN "discord_event_id" text;--> statement-breakpoint
ALTER TABLE "agent_event_audits" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_event_grants" ADD COLUMN "max_events" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_event_grants" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_event_idempotency_keys" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "causer_type" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "event" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "batch_uuid" uuid;