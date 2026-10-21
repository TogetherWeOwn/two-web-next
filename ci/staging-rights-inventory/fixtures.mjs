// Invented, in-memory fixtures. Not a live census or an accepted rights image.
import { READS } from "./reads.mjs";

export function fixture() {
  const acl = {
    owner_oid: 40,
    acl_state: "explicit",
    grantor_oid: 40,
    grantee_oid: 10,
    privilege: "SELECT",
    grantable: false,
  };
  const noAcl = {
    owner_oid: 40,
    acl_state: "empty",
    grantor_oid: null,
    grantee_oid: null,
    privilege: null,
    grantable: null,
  };
  const roles = [
    [10, "two_web_app"],
    [20, "pg_read_all_data"],
    [30, "pg_write_all_data"],
    [40, "synthetic_owner"],
    [50, "synthetic_delegate"],
    [60, "synthetic_nested"],
  ].map(([role_oid, role_name]) => ({
    role_oid,
    role_name,
    superuser: false,
    inherit: true,
    create_role: false,
    create_database: false,
    can_login: false,
    replication: false,
    bypass_rls: false,
  }));
  const rows = {
    identity: [
      {
        current_user_name: "synthetic_session",
        session_user_name: "synthetic_session",
        database_name: "synthetic_database",
        server_version: "18.0",
        server_version_num: 180000,
        server_address_present: true,
      },
    ],
    schemas: [
      { schema_oid: 1, schema_name: "public", owner_oid: 40, acl_state: "explicit" },
      { schema_oid: 2, schema_name: "drizzle", owner_oid: 40, acl_state: "explicit" },
    ],
    relations: [
      {
        relation_oid: 100,
        schema_name: "public",
        relation_name: "users",
        relation_kind: "r",
        owner_oid: 40,
        row_security: false,
        force_row_security: false,
        is_partition: false,
      },
      {
        relation_oid: 101,
        schema_name: "drizzle",
        relation_name: "__drizzle_migrations",
        relation_kind: "r",
        owner_oid: 40,
        row_security: false,
        force_row_security: false,
        is_partition: false,
      },
      {
        relation_oid: 102,
        schema_name: "public",
        relation_name: "synthetic_sequence",
        relation_kind: "S",
        owner_oid: 40,
        row_security: false,
        force_row_security: false,
        is_partition: false,
      },
    ],
    columns: [100, 101].map((relation_oid) => ({
      relation_oid,
      column_number: 1,
      column_name: "id",
      type_oid: 23,
      type_modifier: -1,
      identity_kind: "",
      generated_kind: "",
      acl_state: "null-default",
    })),
    partitions: [],
    sequence_dependencies: [
      {
        sequence_oid: 102,
        sequence_schema: "public",
        sequence_name: "synthetic_sequence",
        owner_oid: 40,
        referenced_oid: 100,
        referenced_column: 1,
        dependency_kind: "a",
      },
    ],
    relation_acls: [
      { relation_oid: 100, ...acl, acl_state: "null-default" },
      { relation_oid: 101, ...acl, grantee_oid: 0, grantable: true },
      { relation_oid: 102, ...noAcl },
    ],
    column_acls: [100, 101].map((relation_oid) => ({
      relation_oid,
      column_number: 1,
      ...noAcl,
      acl_state: "null-default",
    })),
    schema_acls: [1, 2].map((schema_oid) => ({ schema_oid, ...acl, privilege: "USAGE" })),
    memberships: [
      [20, 10],
      [30, 20],
      [10, 50],
      [50, 60],
    ].map(([role_oid, member_oid], index) => ({
      membership_oid: index + 1,
      role_oid,
      member_oid,
      grantor_oid: 40,
      admin_option: false,
      inherit_option: true,
      set_option: true,
    })),
    roles,
    // Independent known closure for this graph, not the implementation's helper.
    member_checks: roles.flatMap((r) =>
      [10, 20, 30].map((role_oid) => ({
        member_oid: r.role_oid,
        role_oid,
        is_member: {
          10: [10, 20, 30],
          20: [20, 30],
          30: [30],
          40: [40],
          50: [10, 20, 30, 50],
          60: [10, 20, 30, 50, 60],
        }[r.role_oid].includes(role_oid),
      })),
    ),
    default_acls: [{ default_acl_oid: 500, schema_oid: 0, object_kind: "r", ...acl }],
    policies: [
      {
        policy_oid: 600,
        relation_oid: 100,
        policy_name: "synthetic_policy",
        command: "r",
        role_oids: [0],
        permissive: true,
        expression_present: false,
        check_present: false,
      },
    ],
    functions: [
      {
        function_oid: 700,
        schema_name: "public",
        function_name: "synthetic_guard",
        identity_arguments: "",
        function_kind: "f",
        security_definer: true,
        ...acl,
        privilege: "EXECUTE",
      },
    ],
    triggers: [
      {
        trigger_oid: 800,
        relation_oid: 100,
        function_oid: 700,
        trigger_name: "synthetic_trigger",
        internal: false,
        enabled: "O",
      },
    ],
  };
  return Object.fromEntries(
    READS.map((r) => [r.id, { complete: true, fields: [...r.fields], rows: rows[r.id] }]),
  );
}
