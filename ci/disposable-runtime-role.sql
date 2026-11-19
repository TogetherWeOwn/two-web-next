-- Only for newly created, disposable test clusters. Never use on a live database.
-- The role is cluster-wide: serialize creation and leave cleanup to the cluster owner.
BEGIN;
SELECT pg_advisory_xact_lock(824619410);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'two_web_app') THEN
    CREATE ROLE two_web_app NOLOGIN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'two_web_app'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'disposable runtime role has unexpected privileges';
  END IF;
END;
$$;
COMMIT;

-- Exercise a migration-style individual grant without leaving an object behind.
BEGIN;
CREATE TEMP TABLE runtime_grant_proof (id integer);
GRANT SELECT ON runtime_grant_proof TO two_web_app;
DO $$
BEGIN
  IF NOT has_table_privilege('two_web_app', 'runtime_grant_proof', 'SELECT') THEN
    RAISE EXCEPTION 'runtime grant proof failed';
  END IF;
END;
$$;
ROLLBACK;
