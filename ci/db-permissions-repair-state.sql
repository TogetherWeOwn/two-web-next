-- Bounded migration ledger and catalog metadata only. No application rows.
WITH objects AS (
    SELECT c.oid, c.relowner, c.relkind, n.nspname || '.' || c.relname AS name,
           c.relrowsecurity, c.relforcerowsecurity, c.relacl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ((n.nspname = 'public' AND c.relkind IN ('r','p','S'))
        OR (n.nspname = 'drizzle' AND c.relname IN ('__drizzle_migrations','__drizzle_migrations_id_seq')))
  ), serial_links AS (
    SELECT objid, refobjid, refobjsubid, deptype
    FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
      AND d.deptype IN ('a','i') AND d.refobjsubid > 0
      AND (d.objid IN (SELECT oid FROM objects WHERE relkind = 'S')
        OR (d.refobjid IN (SELECT oid FROM objects)
          AND EXISTS (SELECT 1 FROM pg_class seq WHERE seq.oid = d.objid AND seq.relkind = 'S')))
  ), namespaces AS (
    SELECT oid, nspname::text AS name, nspowner AS owner,
           coalesce(nspacl, acldefault('n', nspowner)) AS acl
      FROM pg_namespace WHERE nspname IN ('public','drizzle')
  ), acl_targets AS (
    SELECT oid, name, owner, acl FROM namespaces
    UNION ALL
    SELECT oid, datname, datdba, coalesce(datacl, acldefault('d', datdba))
      FROM pg_database WHERE datname = current_database()
  ), object_privileges AS (
    SELECT name, 0 AS column_number, pg_get_userbyid(a.grantor) AS grantor, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type, a.is_grantable
      FROM objects o CROSS JOIN LATERAL aclexplode(o.relacl) a
    UNION ALL
    SELECT o.name, p.attnum, pg_get_userbyid(a.grantor) AS grantor, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type, a.is_grantable
      FROM objects o JOIN pg_attribute p ON p.attrelid = o.oid
      CROSS JOIN LATERAL aclexplode(p.attacl) a
     WHERE p.attnum > 0 AND NOT p.attisdropped
  ), checks AS (
    SELECT ARRAY['SELECT','UPDATE','USAGE'] AS seq,
           ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] AS tab,
           ARRAY['USAGE','CREATE'] AS ns, ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] AS col
  ), all_checks AS (
    SELECT * FROM checks
    UNION ALL SELECT ARRAY(SELECT x || ' WITH GRANT OPTION' FROM unnest(seq) x),
      ARRAY(SELECT x || ' WITH GRANT OPTION' FROM unnest(tab) x),
      ARRAY(SELECT x || ' WITH GRANT OPTION' FROM unnest(ns) x),
      ARRAY(SELECT x || ' WITH GRANT OPTION' FROM unnest(col) x)
    FROM checks
  ), app_rights AS (
    SELECT name, 0 AS column_number, perm,
      CASE WHEN relkind = 'S' THEN has_sequence_privilege('two_web_app', oid, perm)
           ELSE has_table_privilege('two_web_app', oid, perm) END AS allowed
    FROM objects CROSS JOIN all_checks CROSS JOIN LATERAL unnest(CASE WHEN relkind = 'S' THEN seq ELSE tab END) perm
    UNION ALL SELECT name, 0, perm, has_schema_privilege('two_web_app', oid, perm)
      FROM namespaces CROSS JOIN all_checks CROSS JOIN LATERAL unnest(ns) perm
    UNION ALL SELECT o.name, p.attnum, perm, has_column_privilege('two_web_app', o.oid, p.attnum, perm)
      FROM objects o JOIN pg_attribute p ON p.attrelid = o.oid
      CROSS JOIN all_checks CROSS JOIN LATERAL unnest(col) perm
      WHERE o.relkind IN ('r','p') AND p.attnum > 0 AND NOT p.attisdropped
  ), ledger AS MATERIALIZED (
    SELECT id, created_at, hash FROM ONLY drizzle.__drizzle_migrations
    ORDER BY created_at, id LIMIT 35
  ), relevant_roles AS (
    SELECT oid, to_jsonb(r) - 'rolpassword' - 'rolconfig' AS attributes
    FROM pg_roles r
    WHERE rolname IN (current_user, 'postgres', 'two_web_migrate', 'two_web_app', 'two_web_backup')
      OR r.oid = (SELECT owner FROM namespaces WHERE name = 'drizzle')
  ), snapshot AS (
  SELECT jsonb_build_object(
    'objects', (SELECT jsonb_object_agg(o.name, jsonb_build_array(
      o.oid::bigint, o.relowner::bigint, o.relkind, o.relrowsecurity, o.relforcerowsecurity,
      pg_has_role('two_web_migrate', o.relowner, 'USAGE'))) FROM objects o),
    'inventory', (SELECT jsonb_object_agg(o.name, jsonb_build_array(
      o.relkind, pg_get_userbyid(o.relowner), (SELECT t.name FROM objects t WHERE t.oid = d.refobjid)))
      FROM objects o LEFT JOIN serial_links d ON d.objid = o.oid),
    'dependencies', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.objid,d.refobjid,d.refobjsubid), '[]')
      FROM serial_links d),
    'indexes', (SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, i.indrelid, i.indisvalid,
      pg_get_indexdef(c.oid)) ORDER BY c.oid)
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid IN (SELECT oid FROM objects)),
    'audit', (SELECT jsonb_agg(jsonb_build_array(t.oid, t.tgrelid, t.tgenabled, t.tgfoid,
      pg_get_triggerdef(t.oid), pg_get_functiondef(t.tgfoid), p.proowner, p.prosecdef, p.proconfig)
      ORDER BY t.oid)
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgrelid IN (SELECT oid FROM objects)),
    'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
      FROM pg_policy p WHERE p.polrelid IN (SELECT oid FROM objects)),
    'object_acl', (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY to_jsonb(o)), '[]') FROM object_privileges o),
    'namespaces', (SELECT jsonb_object_agg(name, jsonb_build_array(oid, owner)) FROM acl_targets),
    'schema_db_acl', (SELECT jsonb_agg(jsonb_build_array(t.name, pg_get_userbyid(a.grantor),
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
      ORDER BY t.name, pg_get_userbyid(a.grantor), CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
      FROM acl_targets t CROSS JOIN LATERAL aclexplode(t.acl) a),
    'defaults', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)), '[]') FROM (
      SELECT d.defaclobjtype AS kind, coalesce(n.nspname, '(global)') AS schema,
        pg_get_userbyid(d.defaclrole) AS owner, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
        pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    ) x),
    'app', (SELECT jsonb_agg(jsonb_build_array(name, column_number, perm) ORDER BY name, column_number, perm)
      FROM app_rights WHERE allowed),
    'roles', (SELECT jsonb_agg(attributes ORDER BY oid) FROM relevant_roles),
    'memberships', (SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid, member, grantor)
      FROM pg_auth_members m WHERE roleid IN (SELECT oid FROM relevant_roles)
        OR member IN (SELECT oid FROM relevant_roles)),
    'ledger', (SELECT jsonb_build_object(
      'count', count(*),
      'ids', encode(sha256(convert_to(string_agg(id::text, ',' ORDER BY created_at,id), 'UTF8')), 'hex'),
      'digest', CASE WHEN count(*) > 0 AND count(*) = count(DISTINCT id)
        AND bool_and(coalesce(id > 0 AND created_at > 0 AND hash COLLATE "C" ~ '^[0-9a-f]{64}$', false))
      THEN encode(sha256(convert_to('[' || string_agg(
        CASE WHEN length(hash) = 64 THEN '[' || created_at::text || ',"' || hash || '"]' END,
        ',' ORDER BY created_at,id) || ']', 'UTF8')), 'hex') END
      ) FROM ledger),
    'drizzle_access', jsonb_build_array(
      has_schema_privilege('two_web_migrate', 'drizzle', 'USAGE'),
      has_schema_privilege('two_web_migrate', 'drizzle', 'CREATE')
    ),
    'migrator_ready', (
      has_database_privilege('two_web_migrate', current_database(), 'CONNECT') AND
      has_database_privilege('two_web_migrate', current_database(), 'CREATE') AND
      has_schema_privilege('two_web_migrate', 'public', 'USAGE') AND
      has_schema_privilege('two_web_migrate', 'public', 'CREATE') AND
      has_schema_privilege('two_web_migrate', 'drizzle', 'USAGE') AND
      has_schema_privilege('two_web_migrate', 'drizzle', 'CREATE') AND
      has_table_privilege('two_web_migrate', 'drizzle.__drizzle_migrations', 'SELECT') AND
      has_table_privilege('two_web_migrate', 'drizzle.__drizzle_migrations', 'INSERT') AND
      has_sequence_privilege('two_web_migrate', 'drizzle.__drizzle_migrations_id_seq', 'USAGE') AND
      has_column_privilege('two_web_migrate', 'public.events', 'id', 'REFERENCES') AND
      has_column_privilege('two_web_migrate', 'public.rsvps', 'id', 'REFERENCES')
    )
  ) AS state
)
SELECT state::text AS state, encode(sha256(convert_to(state::text, 'UTF8')), 'hex') AS digest
FROM snapshot
