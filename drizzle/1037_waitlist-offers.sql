CREATE TABLE "waitlist_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rsvp_id" integer NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"notification_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_offers_notification_key_unique" UNIQUE("notification_key"),
	CONSTRAINT "waitlist_offers_state_check" CHECK ("waitlist_offers"."state" IN ('held', 'accepted', 'declined', 'expired')),
	CONSTRAINT "waitlist_offers_window_check" CHECK ("waitlist_offers"."expires_at" > "waitlist_offers"."offered_at")
);
--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_rsvp_id_rsvps_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "public"."rsvps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offers_held_rsvp_idx" ON "waitlist_offers" USING btree ("rsvp_id") WHERE "waitlist_offers"."state" = 'held';--> statement-breakpoint
GRANT SELECT ON TABLE "public"."waitlist_offers" TO "two_web_app";--> statement-breakpoint
GRANT INSERT ON TABLE "public"."waitlist_offers" TO "two_web_app";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."waitlist_offers" TO "two_web_app";