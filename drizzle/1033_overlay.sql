CREATE TABLE "overlay_configs" (
	"member_id" text PRIMARY KEY NOT NULL,
	"elements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overlay_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "overlay_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "overlay_tokens_status_check" CHECK ("overlay_tokens"."status" IN ('live', 'rotated', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE INDEX "overlay_tokens_member_idx" ON "overlay_tokens" USING btree ("member_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "overlay_tokens_member_live_unique" ON "overlay_tokens" USING btree ("member_id") WHERE "overlay_tokens"."status" = 'live';--> statement-breakpoint
-- Reviewed runtime rights (ci/migration-runtime-rights.mjs TABLE_RIGHTS):
-- tokens are minted/read/rotated/pruned by the store; configs are
-- member-upserted only. Quoted "public" so disposable-schema fixtures
-- rewrite these to their own schema like the DDL above.
GRANT DELETE ON TABLE "public"."overlay_tokens" TO "two_web_app";--> statement-breakpoint
GRANT INSERT ON TABLE "public"."overlay_tokens" TO "two_web_app";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."overlay_tokens" TO "two_web_app";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."overlay_tokens" TO "two_web_app";--> statement-breakpoint
GRANT INSERT ON TABLE "public"."overlay_configs" TO "two_web_app";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."overlay_configs" TO "two_web_app";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."overlay_configs" TO "two_web_app";