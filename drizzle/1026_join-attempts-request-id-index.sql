CREATE INDEX IF NOT EXISTS "join_attempts_request_id_idx" ON "join_attempts" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_attempts_discord_id_idx" ON "join_attempts" USING btree ("discord_id");