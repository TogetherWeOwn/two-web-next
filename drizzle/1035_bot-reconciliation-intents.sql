CREATE TABLE "bot_reconciliation_intents" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"verb" text NOT NULL,
	"subject" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer NOT NULL,
	"last_code" text,
	"last_status" integer,
	"last_request_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	CONSTRAINT "bot_reconciliation_verb_known" CHECK ("bot_reconciliation_intents"."verb" in ('announcement.post', 'event.upsert', 'event.cancel', 'reminder.send', 'place_offer.send')),
	CONSTRAINT "bot_reconciliation_subject_bound" CHECK (char_length("bot_reconciliation_intents"."subject") <= 200),
	CONSTRAINT "bot_reconciliation_attempts_positive" CHECK ("bot_reconciliation_intents"."attempts" >= 1),
	CONSTRAINT "bot_reconciliation_resolution_bound" CHECK ("bot_reconciliation_intents"."resolution" is null or char_length("bot_reconciliation_intents"."resolution") <= 500)
);
--> statement-breakpoint
CREATE INDEX "bot_reconciliation_open_idx" ON "bot_reconciliation_intents" USING btree ("first_seen_at") WHERE "bot_reconciliation_intents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "bot_reconciliation_resolved_idx" ON "bot_reconciliation_intents" USING btree ("resolved_at") WHERE "bot_reconciliation_intents"."resolved_at" is not null;--> statement-breakpoint
GRANT INSERT ON TABLE public.bot_reconciliation_intents TO two_web_app;--> statement-breakpoint
GRANT SELECT ON TABLE public.bot_reconciliation_intents TO two_web_app;--> statement-breakpoint
GRANT UPDATE ON TABLE public.bot_reconciliation_intents TO two_web_app;
