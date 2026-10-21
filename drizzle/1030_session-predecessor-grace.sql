CREATE TABLE "web_session_grace" (
	"predecessor_hash" text PRIMARY KEY NOT NULL,
	"successor_hash" text NOT NULL,
	"status_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"avatar" text,
	"member" boolean NOT NULL,
	"moderator" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grace_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "web_session_grace_successor_hash_idx" ON "web_session_grace" USING btree ("successor_hash");--> statement-breakpoint
CREATE INDEX "web_session_grace_status_hash_idx" ON "web_session_grace" USING btree ("status_hash");--> statement-breakpoint
CREATE INDEX "web_session_grace_user_id_idx" ON "web_session_grace" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "web_session_grace_grace_expires_at_idx" ON "web_session_grace" USING btree ("grace_expires_at");