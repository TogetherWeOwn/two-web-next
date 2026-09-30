CREATE TABLE "event_search_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"normalized_query" text NOT NULL,
	"result_count" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_search_logs_zero_idx" ON "event_search_logs" USING btree ("result_count","normalized_query");--> statement-breakpoint
CREATE INDEX "event_search_logs_occurred_at_idx" ON "event_search_logs" USING btree ("occurred_at");