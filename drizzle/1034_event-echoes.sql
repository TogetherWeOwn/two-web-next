CREATE TABLE "event_echo_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"echo_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"sessions" integer NOT NULL,
	"first_joined_at" timestamp with time zone,
	CONSTRAINT "event_echo_members_echo_user_unique" UNIQUE("echo_id","user_id"),
	CONSTRAINT "event_echo_members_minutes_nonnegative" CHECK ("event_echo_members"."minutes" >= 0),
	CONSTRAINT "event_echo_members_sessions_positive" CHECK ("event_echo_members"."sessions" >= 1)
);
--> statement-breakpoint
CREATE TABLE "event_echoes" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"event_key" text NOT NULL,
	"window_starts_at" timestamp with time zone NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"threshold_minutes" integer NOT NULL,
	"peak_concurrent" integer NOT NULL,
	"attended_count" integer NOT NULL,
	"rooms" jsonb NOT NULL,
	"headline" text,
	"announcement_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_echoes_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "event_echoes_threshold_positive" CHECK ("event_echoes"."threshold_minutes" > 0),
	CONSTRAINT "event_echoes_counts_frozen_nonnegative" CHECK ("event_echoes"."peak_concurrent" >= 0 AND "event_echoes"."attended_count" >= 0),
	CONSTRAINT "event_echoes_window_ordered" CHECK ("event_echoes"."window_ends_at" > "event_echoes"."window_starts_at")
);
--> statement-breakpoint
ALTER TABLE "event_echo_members" ADD CONSTRAINT "event_echo_members_echo_id_event_echoes_id_fk" FOREIGN KEY ("echo_id") REFERENCES "public"."event_echoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_echoes" ADD CONSTRAINT "event_echoes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_echo_members_user_id_idx" ON "event_echo_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_echoes_event_key_idx" ON "event_echoes" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "event_echoes_created_at_idx" ON "event_echoes" USING btree ("created_at");--> statement-breakpoint
GRANT INSERT ON TABLE public.event_echoes TO two_web_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.event_echoes TO two_web_app;--> statement-breakpoint
GRANT UPDATE ON TABLE public.event_echoes TO two_web_app;--> statement-breakpoint
GRANT DELETE ON TABLE public.event_echo_members TO two_web_app;--> statement-breakpoint
GRANT INSERT ON TABLE public.event_echo_members TO two_web_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.event_echo_members TO two_web_app;--> statement-breakpoint
GRANT SELECT ON SEQUENCE public.event_echoes_id_seq TO two_web_app;--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.event_echoes_id_seq TO two_web_app;--> statement-breakpoint
GRANT SELECT ON SEQUENCE public.event_echo_members_id_seq TO two_web_app;--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.event_echo_members_id_seq TO two_web_app;