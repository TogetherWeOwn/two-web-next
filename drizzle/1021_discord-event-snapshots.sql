-- Additive display cache only. No canonical event writes or runtime grants.
CREATE TABLE "discord_event_snapshots" (
  "key" varchar(512) PRIMARY KEY NOT NULL,
  "payload" jsonb,
  "succeeded_at" timestamp with time zone,
  "retry_at" timestamp with time zone DEFAULT '1970-01-01T00:00:00Z' NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  CONSTRAINT "discord_snapshot_success_pair" CHECK (("payload" IS NULL) = ("succeeded_at" IS NULL)),
  CONSTRAINT "discord_snapshot_lease_pair" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "discord_snapshot_payload_bound" CHECK (
    "payload" IS NULL OR CASE WHEN jsonb_typeof("payload") = 'array'
      THEN jsonb_array_length("payload") <= 100 AND octet_length("payload"::text) <= 262144
      ELSE false END
  )
);
