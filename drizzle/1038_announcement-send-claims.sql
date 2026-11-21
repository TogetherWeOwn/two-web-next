CREATE TABLE "announcement_send_claims" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"send_attempts" integer NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "announcement_send_claims_attempts_positive" CHECK ("announcement_send_claims"."send_attempts" > 0),
	CONSTRAINT "announcement_send_claims_state_known" CHECK ("announcement_send_claims"."state" in ('sending', 'retryable', 'closed'))
);
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."announcement_send_claims" TO "two_web_app";
--> statement-breakpoint
GRANT INSERT ON TABLE "public"."announcement_send_claims" TO "two_web_app";
--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."announcement_send_claims" TO "two_web_app";
