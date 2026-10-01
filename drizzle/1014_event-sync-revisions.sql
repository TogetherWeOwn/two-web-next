CREATE TABLE "event_sync_attempts" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"revision" bigint NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"mirrored_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"request_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "sync_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "synced_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_sync_attempts" ADD CONSTRAINT "event_sync_attempts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_sync_attempts_pending_idx" ON "event_sync_attempts" USING btree ("event_id") WHERE "event_sync_attempts"."state" = 'pending';
--> statement-breakpoint
-- The revision is an event-level outbox: it commits/rolls back with the write,
-- including a withdrawal that removes the last unsynced RSVP. Mirror/ledger
-- updates never advance it. Triggers cover raw/series inserts as well as routes.
CREATE FUNCTION advance_event_sync_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF ROW(NEW.title, NEW.game, NEW.description, NEW.starts_at, NEW.ends_at,
         NEW.timezone, NEW.location, NEW.capacity, NEW.status, NEW.rsvp_open)
     IS DISTINCT FROM
     ROW(OLD.title, OLD.game, OLD.description, OLD.starts_at, OLD.ends_at,
         OLD.timezone, OLD.location, OLD.capacity, OLD.status, OLD.rsvp_open) THEN
    NEW.sync_revision := OLD.sync_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER events_sync_revision BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION advance_event_sync_revision();
--> statement-breakpoint
CREATE FUNCTION advance_rsvp_sync_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE events SET sync_revision = sync_revision + 1 WHERE id = OLD.event_id;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE events SET sync_revision = sync_revision + 1 WHERE id = NEW.event_id;
  ELSE
    UPDATE events SET sync_revision = sync_revision + 1
      WHERE id IN (OLD.event_id, NEW.event_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rsvps_sync_revision AFTER INSERT OR DELETE OR UPDATE OF status, user_id, event_id ON rsvps
FOR EACH ROW EXECUTE FUNCTION advance_rsvp_sync_revision();
