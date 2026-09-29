CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"bio" text,
	"games" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
