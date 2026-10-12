CREATE TABLE "board_view_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"normalized_board_key" text NOT NULL,
	"scope" text NOT NULL,
	"season" text NOT NULL,
	"result_count" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "board_view_logs_board_occurred_idx" ON "board_view_logs" USING btree ("normalized_board_key","occurred_at");--> statement-breakpoint
CREATE INDEX "board_view_logs_occurred_at_idx" ON "board_view_logs" USING btree ("occurred_at");