CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"log_name" text DEFAULT 'default' NOT NULL,
	"description" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"causer_id" text,
	"properties" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"title" text NOT NULL,
	"game" text,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"location" text,
	"capacity" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"discord_event_id" text,
	"created_by" text,
	"rsvp_open" boolean DEFAULT true NOT NULL,
	"recurrence_frequency" text,
	"recurrence_count" integer,
	"recurrence_ends_on" timestamp,
	"parent_event_id" integer,
	"recurrence_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "events_discord_event_id_unique" UNIQUE("discord_event_id")
);
--> statement-breakpoint
CREATE TABLE "featured_contents" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"image_url" text,
	"image_alt" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_data_access_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"viewer_discord_id" text NOT NULL,
	"viewer_user_id" text,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"subject_user_ids" jsonb NOT NULL,
	"subject_count" integer NOT NULL,
	"route" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_parent_event_id_events_id_fk" FOREIGN KEY ("parent_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_log_name_idx" ON "activity_log" USING btree ("log_name");--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_parent_event_id_idx" ON "events" USING btree ("parent_event_id");--> statement-breakpoint
CREATE INDEX "featured_contents_published_position_idx" ON "featured_contents" USING btree ("is_published","position");--> statement-breakpoint
CREATE INDEX "member_access_viewer_occurred_idx" ON "member_data_access_logs" USING btree ("viewer_discord_id","occurred_at");--> statement-breakpoint
CREATE INDEX "member_access_occurred_idx" ON "member_data_access_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "member_data_access_logs_subject_user_ids_gin" ON "member_data_access_logs" USING gin ("subject_user_ids" jsonb_path_ops);
