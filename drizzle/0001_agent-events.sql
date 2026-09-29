CREATE TABLE "agent_event_audits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"grant_id" uuid,
	"operation" varchar(32) NOT NULL,
	"event_key" varchar(26),
	"idempotency_key" text,
	"payload_digest" varchar(64),
	"request_id" text NOT NULL,
	"result" varchar(16) NOT NULL,
	"reason_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_event_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"company_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"verifier_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_event_grants_verifier_hash_unique" UNIQUE("verifier_hash")
);
--> statement-breakpoint
CREATE TABLE "agent_event_hits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_event_idempotency_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"status" smallint NOT NULL,
	"body" jsonb NOT NULL,
	"event_key" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_event_idempotency_grant_key" UNIQUE("grant_id","key")
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"event_key" varchar(26) PRIMARY KEY NOT NULL,
	"agent_grant_id" uuid NOT NULL,
	"proof_marker" text NOT NULL,
	"agent_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"title" varchar(100) NOT NULL,
	"game" varchar(100),
	"description" varchar(1000),
	"starts_at" varchar(16) NOT NULL,
	"ends_at" varchar(16) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"location" varchar(255) NOT NULL,
	"capacity" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_events_agent_grant_id_unique" UNIQUE("agent_grant_id"),
	CONSTRAINT "agent_events_proof_marker_unique" UNIQUE("proof_marker")
);
--> statement-breakpoint
ALTER TABLE "agent_event_audits" ADD CONSTRAINT "agent_event_audits_grant_id_agent_event_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_event_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event_idempotency_keys" ADD CONSTRAINT "agent_event_idempotency_keys_grant_id_agent_event_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_event_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_grant_id_agent_event_grants_id_fk" FOREIGN KEY ("agent_grant_id") REFERENCES "public"."agent_event_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_event_audits_grant_created_idx" ON "agent_event_audits" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_event_audits_event_key_idx" ON "agent_event_audits" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "agent_event_grants_agent_id_idx" ON "agent_event_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_event_hits_bucket_at_idx" ON "agent_event_hits" USING btree ("bucket","at");