CREATE TABLE "job_unique_locks" (
	"key" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
