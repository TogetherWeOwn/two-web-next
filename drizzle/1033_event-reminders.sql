CREATE TABLE "event_reminder_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"lead" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_reminder_deliveries_event_user_lead_channel_unique" UNIQUE("event_id","user_id","lead","channel"),
	CONSTRAINT "event_reminder_deliveries_lead_check" CHECK ("event_reminder_deliveries"."lead" IN ('24h', '1h')),
	CONSTRAINT "event_reminder_deliveries_channel_check" CHECK ("event_reminder_deliveries"."channel" IN ('site', 'dm')),
	CONSTRAINT "event_reminder_deliveries_status_check" CHECK ("event_reminder_deliveries"."status" IN ('sent', 'skipped_muted', 'skipped_optout', 'skipped_cap', 'skipped_rsvp', 'skipped_window', 'failed', 'dm_blocked'))
);
--> statement-breakpoint
CREATE TABLE "event_reminder_mutes" (
	"event_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_reminder_mutes_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"event_id" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "reminder_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_reminder_deliveries" ADD CONSTRAINT "event_reminder_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminder_mutes" ADD CONSTRAINT "event_reminder_mutes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_reminder_mutes_user_id_idx" ON "event_reminder_mutes" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications" USING btree ("user_id","read_at");
--> statement-breakpoint
CREATE INDEX "event_reminder_deliveries_user_id_idx" ON "event_reminder_deliveries" USING btree ("user_id");
--> statement-breakpoint
GRANT DELETE ON TABLE public.event_reminder_mutes TO two_web_app;
--> statement-breakpoint
GRANT INSERT ON TABLE public.event_reminder_mutes TO two_web_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.event_reminder_mutes TO two_web_app;
--> statement-breakpoint
GRANT INSERT ON TABLE public.notifications TO two_web_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.notifications TO two_web_app;
--> statement-breakpoint
GRANT UPDATE(read_at) ON TABLE public.notifications TO two_web_app;
--> statement-breakpoint
GRANT DELETE ON TABLE public.event_reminder_deliveries TO two_web_app;
--> statement-breakpoint
GRANT INSERT ON TABLE public.event_reminder_deliveries TO two_web_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.event_reminder_deliveries TO two_web_app;
--> statement-breakpoint
GRANT SELECT ON SEQUENCE public.notifications_id_seq TO two_web_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.notifications_id_seq TO two_web_app;
--> statement-breakpoint
GRANT SELECT ON SEQUENCE public.event_reminder_deliveries_id_seq TO two_web_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.event_reminder_deliveries_id_seq TO two_web_app;