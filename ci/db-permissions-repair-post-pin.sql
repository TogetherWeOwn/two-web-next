-- $1 is the projected POST catalog as JSON text. Keep ACL ordering aligned
-- with db-permissions-repair-state.sql. A cast from JSON text to name retains
-- the text collation, whereas pg_get_userbyid() uses C collation.
WITH projected AS (
  SELECT $1::text::jsonb AS state
), canonical AS (
  SELECT state || jsonb_build_object(
    'object_acl', (SELECT coalesce(jsonb_agg(acl ORDER BY acl), '[]'::jsonb)
      FROM jsonb_array_elements(state->'object_acl') acl),
    'schema_db_acl', (SELECT jsonb_agg(acl ORDER BY acl->>0,
      (acl->>1)::name COLLATE "C", (acl->>2)::name COLLATE "C", acl->>3, acl->>4)
      FROM jsonb_array_elements(state->'schema_db_acl') acl)
  ) AS state
  FROM projected
)
SELECT encode(sha256(convert_to(state::text, 'UTF8')), 'hex') AS digest
FROM canonical
