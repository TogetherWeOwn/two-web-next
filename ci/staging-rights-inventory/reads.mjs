// Candidate PostgreSQL 18 reads, not an executable collector. No caller SQL/inputs.
function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
}

export const POLICY_TABLES = freeze([
  "users",
  "profiles",
  "discord_event_snapshots",
  "job_unique_locks",
  "queue_jobs",
  "featured_contents",
  "rsvps",
  "agent_event_idempotency_keys",
  "agent_event_audits",
  "agent_event_hits",
  "member_data_access_logs",
  "event_search_logs",
  "board_view_logs",
  "events",
  "event_sync_attempts",
  "queue_failed_jobs",
  "activity_log",
  "agent_event_grants",
  "join_attempts",
  "web_throttle_hits",
  "web_sessions",
  "web_oauth_journeys",
]);

// Exact catalog-column surface. No wildcard or visibility-filtered grants views.
export const CATALOG_COLUMNS = freeze({
  pg_class: [
    "oid",
    "relnamespace",
    "relname",
    "relkind",
    "relowner",
    "relrowsecurity",
    "relforcerowsecurity",
    "relispartition",
    "relacl",
  ],
  pg_namespace: ["oid", "nspname", "nspowner", "nspacl"],
  pg_attribute: [
    "attrelid",
    "attnum",
    "attname",
    "atttypid",
    "atttypmod",
    "attidentity",
    "attgenerated",
    "attisdropped",
    "attacl",
  ],
  pg_inherits: ["inhrelid", "inhparent", "inhseqno", "inhdetachpending"],
  pg_depend: ["classid", "objid", "objsubid", "refclassid", "refobjid", "refobjsubid", "deptype"],
  pg_auth_members: [
    "oid",
    "roleid",
    "member",
    "grantor",
    "admin_option",
    "inherit_option",
    "set_option",
  ],
  pg_roles: [
    "oid",
    "rolname",
    "rolsuper",
    "rolinherit",
    "rolcreaterole",
    "rolcreatedb",
    "rolcanlogin",
    "rolreplication",
    "rolbypassrls",
  ],
  pg_default_acl: ["oid", "defaclrole", "defaclnamespace", "defaclobjtype", "defaclacl"],
  pg_policy: [
    "oid",
    "polname",
    "polrelid",
    "polcmd",
    "polroles",
    "polpermissive",
    "polqual",
    "polwithcheck",
  ],
  pg_proc: [
    "oid",
    "pronamespace",
    "proname",
    "proowner",
    "proacl",
    "prosecdef",
    "prokind",
    "proargtypes",
  ],
  pg_trigger: ["oid", "tgrelid", "tgfoid", "tgname", "tgisinternal", "tgenabled"],
});
export const BUILTINS = freeze([
  "current_database",
  "current_setting",
  "inet_server_addr",
  "aclexplode",
  "acldefault",
  "cardinality",
  "pg_has_role",
  "oidvectortypes",
]);
export const TRANSACTION = freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  setup: [
    "SET LOCAL search_path = pg_catalog",
    "SET LOCAL statement_timeout = '30s'",
    "SET LOCAL lock_timeout = '10s'",
    "SET LOCAL idle_in_transaction_session_timeout = '30s'",
    "SET LOCAL client_min_messages = error",
  ],
  connectionSeconds: 10,
  wallClockMilliseconds: 600000,
  maxConnections: 1,
  tls: "verified-hostname-and-certificate-required",
});

const read = (id, prechecks, types, sql) => ({
  id,
  prechecks,
  types,
  fields: Object.keys(types),
  sql,
});

// Components are constant source text, never assembled from rows or caller input.
const scope = "n.nspname IN ('public', 'drizzle')";
const aclState = (column) =>
  `CASE WHEN ${column} IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(${column}) = 0 THEN 'empty' ELSE 'explicit' END`;

// Named private principals cannot be selected publicly. No substitutes or scan of
// all roles: this bounded graph is a candidate subset, never a complete verdict.
const graph = `WITH RECURSIVE objects(owner_oid, acl) AS (
  SELECT c.relowner, c.relacl FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${scope}
  UNION ALL SELECT c.relowner, a.attacl FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE ${scope} AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT n.nspowner, n.nspacl FROM pg_catalog.pg_namespace n WHERE ${scope}
  UNION ALL SELECT p.proowner, p.proacl FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${scope}
  UNION ALL SELECT d.defaclrole, d.defaclacl FROM pg_catalog.pg_default_acl d
), acl_entries AS (
  SELECT x.grantor, x.grantee FROM objects o
  CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) x
), participants(oid) AS (
  SELECT o.owner_oid FROM objects o
  UNION SELECT x.grantor FROM acl_entries x
  UNION SELECT x.grantee FROM acl_entries x WHERE x.grantee <> 0
), roots(oid) AS (
  SELECT r.oid FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('two_web_app', 'pg_read_all_data', 'pg_write_all_data')
  UNION SELECT x.grantor FROM acl_entries x
), paths(oid, direction) AS (
  SELECT roots.oid, 'forward'::text FROM roots
  UNION SELECT roots.oid, 'reverse'::text FROM roots
  UNION
  SELECT CASE WHEN w.direction = 'forward' THEN m.roleid ELSE m.member END, w.direction
  FROM paths w JOIN pg_catalog.pg_auth_members m
    ON (w.direction = 'forward' AND m.member = w.oid)
    OR (w.direction = 'reverse' AND m.roleid = w.oid)
), edges AS (
  SELECT m.oid, m.roleid, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option
  FROM pg_catalog.pg_auth_members m
  WHERE EXISTS (SELECT w.oid FROM paths w
    WHERE (w.direction = 'forward' AND w.oid = m.member)
       OR (w.direction = 'reverse' AND w.oid = m.roleid))
), relevant(oid) AS (
  SELECT paths.oid FROM paths
  UNION SELECT edges.grantor FROM edges
  UNION SELECT participants.oid FROM participants
)`;

export const READS = freeze([
  read(
    "identity",
    [1, 13, 15],
    {
      current_user_name: "text",
      session_user_name: "text",
      database_name: "text",
      server_version: "text",
      server_version_num: "integer",
      server_address_present: "boolean",
    },
    `SELECT current_user::text AS current_user_name, session_user::text AS session_user_name,
  pg_catalog.current_database() AS database_name,
  pg_catalog.current_setting('server_version') AS server_version,
  pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
  (pg_catalog.inet_server_addr() IS NOT NULL) AS server_address_present`,
  ),
  read(
    "schemas",
    [4, 7, 11, 12],
    {
      schema_oid: "oid",
      schema_name: "text",
      owner_oid: "oid",
      acl_state: "text",
    },
    `SELECT n.oid AS schema_oid, n.nspname::text AS schema_name, n.nspowner AS owner_oid,
  ${aclState("n.nspacl")} AS acl_state
  FROM pg_catalog.pg_namespace n WHERE ${scope} ORDER BY n.oid`,
  ),
  read(
    "relations",
    [3, 4, 13],
    {
      relation_oid: "oid",
      schema_name: "text",
      relation_name: "text",
      relation_kind: "text",
      owner_oid: "oid",
      row_security: "boolean",
      force_row_security: "boolean",
      is_partition: "boolean",
    },
    `SELECT c.oid AS relation_oid, n.nspname::text AS schema_name, c.relname::text AS relation_name,
  c.relkind::text AS relation_kind, c.relowner AS owner_oid, c.relrowsecurity AS row_security,
  c.relforcerowsecurity AS force_row_security, c.relispartition AS is_partition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE ${scope} ORDER BY n.nspname, c.relname, c.oid`,
  ),
  read(
    "columns",
    [3, 7, 9],
    {
      relation_oid: "oid",
      column_number: "integer",
      column_name: "text",
      type_oid: "oid",
      type_modifier: "integer",
      identity_kind: "string",
      generated_kind: "string",
      acl_state: "text",
    },
    `SELECT a.attrelid AS relation_oid, a.attnum::integer AS column_number,
  a.attname::text AS column_name, a.atttypid AS type_oid, a.atttypmod AS type_modifier,
  a.attidentity::text AS identity_kind, a.attgenerated::text AS generated_kind,
  ${aclState("a.attacl")} AS acl_state
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE ${scope} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum`,
  ),
  read(
    "partitions",
    [3],
    {
      relation_oid: "oid",
      parent_oid: "oid",
      sequence_number: "integer",
      detach_pending: "boolean",
    },
    `SELECT i.inhrelid AS relation_oid, i.inhparent AS parent_oid,
  i.inhseqno AS sequence_number, i.inhdetachpending AS detach_pending
  FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
  JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
  WHERE ${scope} OR pn.nspname IN ('public', 'drizzle') ORDER BY i.inhrelid, i.inhseqno`,
  ),
  read(
    "sequence_dependencies",
    [3, 4, 12],
    {
      sequence_oid: "oid",
      sequence_schema: "text",
      sequence_name: "text",
      owner_oid: "oid",
      referenced_oid: "oid",
      referenced_column: "integer",
      dependency_kind: "text",
    },
    `SELECT c.oid AS sequence_oid, n.nspname::text AS sequence_schema,
  c.relname::text AS sequence_name, c.relowner AS owner_oid,
  d.refobjid AS referenced_oid, d.refobjsubid AS referenced_column, d.deptype::text AS dependency_kind
  FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class c ON c.oid = d.objid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE ${scope} AND c.relkind = 'S'
    AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND d.objsubid = 0 AND d.deptype IN ('a', 'i') ORDER BY c.oid, d.refobjid, d.refobjsubid`,
  ),
  read(
    "relation_acls",
    [7, 9, 12],
    {
      relation_oid: "oid",
      owner_oid: "oid",
      acl_state: "text",
      grantor_oid: "nullable-oid",
      grantee_oid: "nullable-public-oid",
      privilege: "nullable-text",
      grantable: "nullable-boolean",
    },
    `SELECT c.oid AS relation_oid, c.relowner AS owner_oid, ${aclState("c.relacl")} AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
    pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) x ON true
  WHERE ${scope} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ORDER BY c.oid, x.grantor, x.grantee, x.privilege_type`,
  ),
  read(
    "column_acls",
    [7, 9],
    {
      relation_oid: "oid",
      column_number: "integer",
      owner_oid: "oid",
      acl_state: "text",
      grantor_oid: "nullable-oid",
      grantee_oid: "nullable-public-oid",
      privilege: "nullable-text",
      grantable: "nullable-boolean",
    },
    `SELECT a.attrelid AS relation_oid, a.attnum::integer AS column_number,
  c.relowner AS owner_oid, ${aclState("a.attacl")} AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(a.attacl) x ON true
  WHERE ${scope} AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attrelid, a.attnum, x.grantor, x.grantee, x.privilege_type`,
  ),
  read(
    "schema_acls",
    [7, 11, 12],
    {
      schema_oid: "oid",
      owner_oid: "oid",
      acl_state: "text",
      grantor_oid: "nullable-oid",
      grantee_oid: "nullable-public-oid",
      privilege: "nullable-text",
      grantable: "nullable-boolean",
    },
    `SELECT n.oid AS schema_oid, n.nspowner AS owner_oid, ${aclState("n.nspacl")} AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_namespace n
  LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) x ON true
  WHERE ${scope} ORDER BY n.oid, x.grantor, x.grantee, x.privilege_type`,
  ),
  read(
    "memberships",
    [5, 6, 15],
    {
      membership_oid: "oid",
      role_oid: "oid",
      member_oid: "oid",
      grantor_oid: "oid",
      admin_option: "boolean",
      inherit_option: "boolean",
      set_option: "boolean",
    },
    `${graph}
  SELECT e.oid AS membership_oid, e.roleid AS role_oid, e.member AS member_oid,
  e.grantor AS grantor_oid, e.admin_option, e.inherit_option, e.set_option
  FROM edges e ORDER BY e.roleid, e.member, e.grantor`,
  ),
  read(
    "roles",
    [5, 6, 13, 15, 18],
    {
      role_oid: "oid",
      role_name: "text",
      superuser: "boolean",
      inherit: "boolean",
      create_role: "boolean",
      create_database: "boolean",
      can_login: "boolean",
      replication: "boolean",
      bypass_rls: "boolean",
    },
    `${graph}
  SELECT r.oid AS role_oid, r.rolname::text AS role_name, r.rolsuper AS superuser,
  r.rolinherit AS inherit, r.rolcreaterole AS create_role, r.rolcreatedb AS create_database,
  r.rolcanlogin AS can_login, r.rolreplication AS replication, r.rolbypassrls AS bypass_rls
  FROM pg_catalog.pg_roles r JOIN relevant v ON v.oid = r.oid ORDER BY r.oid`,
  ),
  read(
    "member_checks",
    [6],
    {
      member_oid: "oid",
      role_oid: "oid",
      is_member: "boolean",
    },
    `${graph}
  SELECT r.oid AS member_oid, target.oid AS role_oid,
  pg_catalog.pg_has_role(r.oid, target.oid, 'MEMBER') AS is_member
  FROM relevant r CROSS JOIN pg_catalog.pg_roles target
  WHERE target.rolname IN ('two_web_app', 'pg_read_all_data', 'pg_write_all_data')
  ORDER BY r.oid, target.oid`,
  ),
  read(
    "default_acls",
    [11, 16],
    {
      default_acl_oid: "oid",
      owner_oid: "oid",
      schema_oid: "public-oid",
      object_kind: "text",
      acl_state: "text",
      grantor_oid: "nullable-oid",
      grantee_oid: "nullable-public-oid",
      privilege: "nullable-text",
      grantable: "nullable-boolean",
    },
    `SELECT d.oid AS default_acl_oid, d.defaclrole AS owner_oid,
  d.defaclnamespace AS schema_oid, d.defaclobjtype::text AS object_kind,
  ${aclState("d.defaclacl")} AS acl_state, x.grantor AS grantor_oid,
  x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_default_acl d LEFT JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x ON true
  ORDER BY d.oid, x.grantor, x.grantee, x.privilege_type`,
  ),
  read(
    "policies",
    [13],
    {
      policy_oid: "oid",
      relation_oid: "oid",
      policy_name: "text",
      command: "text",
      role_oids: "oid-array",
      permissive: "boolean",
      expression_present: "boolean",
      check_present: "boolean",
    },
    `SELECT p.oid AS policy_oid, p.polrelid AS relation_oid, p.polname::text AS policy_name,
  p.polcmd::text AS command, p.polroles AS role_oids, p.polpermissive AS permissive,
  (p.polqual IS NOT NULL) AS expression_present, (p.polwithcheck IS NOT NULL) AS check_present
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname = 'public' AND c.relname IN (${POLICY_TABLES.map((t) => `'${t}'`).join(", ")}))
    OR (n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations') ORDER BY p.oid`,
  ),
  read(
    "functions",
    [14],
    {
      function_oid: "oid",
      schema_name: "text",
      function_name: "text",
      identity_arguments: "string",
      function_kind: "text",
      owner_oid: "oid",
      security_definer: "boolean",
      acl_state: "text",
      grantor_oid: "nullable-oid",
      grantee_oid: "nullable-public-oid",
      privilege: "nullable-text",
      grantable: "nullable-boolean",
    },
    `SELECT p.oid AS function_oid, n.nspname::text AS schema_name, p.proname::text AS function_name,
  pg_catalog.oidvectortypes(p.proargtypes) AS identity_arguments, p.prokind::text AS function_kind,
  p.proowner AS owner_oid, p.prosecdef AS security_definer, ${aclState("p.proacl")} AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) x ON true
  WHERE ${scope} ORDER BY p.oid, x.grantor, x.grantee, x.privilege_type`,
  ),
  read(
    "triggers",
    [14],
    {
      trigger_oid: "oid",
      relation_oid: "oid",
      function_oid: "oid",
      trigger_name: "text",
      internal: "boolean",
      enabled: "text",
    },
    `SELECT t.oid AS trigger_oid, t.tgrelid AS relation_oid, t.tgfoid AS function_oid,
  t.tgname::text AS trigger_name, t.tgisinternal AS internal, t.tgenabled::text AS enabled
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE ${scope} ORDER BY t.tgrelid, t.oid`,
  ),
]);
