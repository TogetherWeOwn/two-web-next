-- Reference definition, exercised by the disposable /up fixture; not a migration.
-- The trusted owner creates both objects and retains access to the base column.
-- The runtime gets schema USAGE and view SELECT separately, never ownership,
-- schema CREATE, or membership in the owner role.
CREATE SCHEMA web_readiness;
REVOKE ALL ON SCHEMA web_readiness FROM PUBLIC;

-- OFFSET preserves every timestamp (including NULL) without making this view
-- automatically updatable, even if the caller inherits broad DML privileges.
CREATE VIEW web_readiness.migration_timestamps WITH (security_invoker = false) AS
  SELECT created_at FROM drizzle.__drizzle_migrations OFFSET 0;
REVOKE ALL ON TABLE web_readiness.migration_timestamps FROM PUBLIC;
