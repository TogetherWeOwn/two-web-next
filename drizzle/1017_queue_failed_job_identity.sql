-- Drizzle applies migrations in a transaction. Fence terminal writers while
-- repairing historical redeliveries and installing the unique dispatch identity.
LOCK TABLE "queue_failed_jobs" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- Keep the first recorded outcome (smallest ledger id), never dedupe by event key.
DELETE FROM "queue_failed_jobs" AS duplicate
USING "queue_failed_jobs" AS original
WHERE duplicate."job_id" = original."job_id" AND duplicate."id" > original."id";
--> statement-breakpoint
ALTER TABLE "queue_failed_jobs" ADD CONSTRAINT "queue_failed_jobs_job_id_unique" UNIQUE("job_id");
