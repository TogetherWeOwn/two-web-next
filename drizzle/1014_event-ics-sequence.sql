ALTER TABLE events ADD COLUMN ics_sequence bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Preserve the revision calendar subscribers saw before this migration.
UPDATE events SET ics_sequence = GREATEST(0,
  FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')))::bigint);
--> statement-breakpoint
-- Same database-owned counter and names as legacy two-web. OLD is the persisted
-- revision even for stale saves, bulk SQL and timestamps moving backwards.
CREATE OR REPLACE FUNCTION advance_event_ics_sequence() RETURNS trigger AS $$
DECLARE
  timestamp_sequence bigint;
BEGIN
  timestamp_sequence := GREATEST(0,
    FLOOR(EXTRACT(EPOCH FROM COALESCE(NEW.updated_at, NEW.created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')))::bigint);
  IF TG_OP = 'INSERT' THEN
    NEW.ics_sequence := timestamp_sequence;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    NEW.ics_sequence := GREATEST(OLD.ics_sequence + 1, timestamp_sequence);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_ics_sequence
  BEFORE INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION advance_event_ics_sequence();
