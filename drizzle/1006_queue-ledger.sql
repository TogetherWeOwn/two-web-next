CREATE TABLE "queue_failed_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"reason" text NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_jobs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"available_at" timestamp with time zone NOT NULL,
	"reserved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
