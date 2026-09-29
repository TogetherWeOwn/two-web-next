CREATE TABLE "join_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"source" varchar(64),
	"request_id" text,
	"discord_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_throttle_hits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "join_attempts_created_at_idx" ON "join_attempts" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "web_throttle_hits_bucket_at_idx" ON "web_throttle_hits" USING btree ("bucket","at");
