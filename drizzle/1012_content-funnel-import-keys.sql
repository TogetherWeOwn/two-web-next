ALTER TABLE "join_attempts" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "event_search_logs" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "featured_contents" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "join_attempts" ADD CONSTRAINT "join_attempts_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "event_search_logs" ADD CONSTRAINT "event_search_logs_legacy_id_unique" UNIQUE("legacy_id");--> statement-breakpoint
ALTER TABLE "featured_contents" ADD CONSTRAINT "featured_contents_legacy_id_unique" UNIQUE("legacy_id");