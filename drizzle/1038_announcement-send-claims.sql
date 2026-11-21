CREATE TABLE "announcement_send_claims" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"channel_alias" text NOT NULL,
	"send_attempts" integer NOT NULL,
	"state" text NOT NULL,
	"claim_until" timestamp with time zone NOT NULL,
	CONSTRAINT "announcement_send_claims_alias_valid" CHECK ("announcement_send_claims"."channel_alias" ~ '^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$'),
	CONSTRAINT "announcement_send_claims_attempts_positive" CHECK ("announcement_send_claims"."send_attempts" > 0),
	CONSTRAINT "announcement_send_claims_state_known" CHECK ("announcement_send_claims"."state" in ('sending', 'retryable', 'closed'))
);
--> statement-breakpoint
CREATE INDEX "announcement_send_claims_retired_idx" ON "announcement_send_claims" USING btree ("claim_until","idempotency_key") WHERE "announcement_send_claims"."state" = 'closed';
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."announcement_send_claims" TO "two_web_app";
--> statement-breakpoint
GRANT INSERT ON TABLE "public"."announcement_send_claims" TO "two_web_app";
--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."announcement_send_claims" TO "two_web_app";
