-- Audit evidence is append-only (TOG-10289, CISO disposition TOG-10264 §2).
-- agent_event_audits, member_data_access_logs and activity_log accept INSERT;
-- UPDATE and TRUNCATE are refused for every role, and DELETE only passes for a
-- row strictly older than 90 days by its age column (the retention exception
-- the model:prune adapter in src/jobs/postgres.ts relies on). There is no
-- bypass setting: a role that may ALTER or DROP these tables (their owner or a
-- superuser) can still disable the triggers, so the deployed web role must not
-- own them and must hold only SELECT/INSERT/DELETE (docs/db-migrations.md).
--
-- The cutoff reads clock_timestamp(), not now(): now() is the transaction start,
-- which precedes the cutoff the prune adapter computes in JS inside that
-- transaction, so a row in between would make the whole prune DELETE raise.
-- 2160 hours, not '90 days': day intervals follow DST in the session TimeZone,
-- the JS cutoff is a fixed 90 * 86_400_000 ms. A NULL age never qualifies.
CREATE FUNCTION "public"."audit_rows_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  aged timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_ARGV[0] = 'occurred_at' THEN
      aged := OLD.occurred_at;
    ELSIF TG_ARGV[0] = 'created_at' THEN
      aged := OLD.created_at;
    END IF;
    IF aged < clock_timestamp() - interval '2160 hours' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_event_audits_append_only" BEFORE UPDATE OR DELETE ON "public"."agent_event_audits"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_rows_append_only"('created_at');
--> statement-breakpoint
CREATE TRIGGER "agent_event_audits_no_truncate" BEFORE TRUNCATE ON "public"."agent_event_audits"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_rows_append_only"();
--> statement-breakpoint
CREATE TRIGGER "member_data_access_logs_append_only" BEFORE UPDATE OR DELETE ON "public"."member_data_access_logs"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_rows_append_only"('occurred_at');
--> statement-breakpoint
CREATE TRIGGER "member_data_access_logs_no_truncate" BEFORE TRUNCATE ON "public"."member_data_access_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_rows_append_only"();
--> statement-breakpoint
CREATE TRIGGER "activity_log_append_only" BEFORE UPDATE OR DELETE ON "public"."activity_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_rows_append_only"('created_at');
--> statement-breakpoint
CREATE TRIGGER "activity_log_no_truncate" BEFORE TRUNCATE ON "public"."activity_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_rows_append_only"();
