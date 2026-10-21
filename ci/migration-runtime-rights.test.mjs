import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  changedMigrationFiles,
  checkChangedMigrations,
  validateDefaultAclRows,
  validateMigrationSql,
} from "./migration-runtime-rights.mjs";

const migration = (sql) => validateMigrationSql("1025_runtime-rights.sql", sql);
const tableGrants = `
  GRANT SELECT ON TABLE public.events TO two_web_app;
  GRANT INSERT ON TABLE public.events TO two_web_app;
  GRANT UPDATE ON TABLE public.events TO two_web_app;
`;

test("accepts an exact reviewed table grant set and its serial sequence grants", () => {
  assert.deepEqual(
    migration(`CREATE TABLE public.events (id serial primary key, title text);${tableGrants}
      GRANT USAGE ON SEQUENCE public.events_id_seq TO two_web_app;
      GRANT SELECT ON SEQUENCE public.events_id_seq TO two_web_app;`),
    [],
  );
});

test("accepts only the candidate column-level update on agent_event_grants", () => {
  assert.deepEqual(
    migration(`CREATE TABLE public.agent_event_grants (id integer primary key, updated_at timestamptz);
      GRANT SELECT ON TABLE public.agent_event_grants TO two_web_app;
      GRANT UPDATE (updated_at) ON TABLE public.agent_event_grants TO two_web_app;`),
    [],
  );
});

test("rejects missing or additional table privileges", () => {
  assert.match(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants.replace("GRANT UPDATE ON TABLE public.events TO two_web_app;", "")}`,
    ).join("\n"),
    /missing reviewed runtime grant/i,
  );
  assert.match(
    migration(`${tableGrants}CREATE TABLE public.events (id integer primary key);
      GRANT DELETE ON TABLE public.events TO two_web_app;`).join("\n"),
    /unreviewed runtime privilege/i,
  );
});

test("rejects bundled privileges and grant options", () => {
  assert.match(
    migration(`CREATE TABLE public.events (id integer primary key);
      GRANT SELECT, INSERT ON TABLE public.events TO two_web_app;
      GRANT UPDATE ON TABLE public.events TO two_web_app;`).join("\n"),
    /one privilege per grant/i,
  );
  assert.match(
    migration(`CREATE TABLE public.events (id integer primary key);${tableGrants}
      GRANT INSERT ON TABLE public.events TO two_web_app WITH GRANT OPTION;`).join("\n"),
    /grant option/i,
  );
});

test("rejects role switching, default-ACL changes, and dynamic SQL", () => {
  for (const forbidden of [
    "SET ROLE two_web_migrate;",
    "SET LOCAL ROLE two_web_migrate;",
    "SET SESSION AUTHORIZATION two_web_migrate;",
    "RESET SESSION AUTHORIZATION;",
    "SELECT set_config('role', 'two_web_migrate', true);",
    "SELECT set_config('session_authorization', 'two_web_migrate', true);",
    "ALTER ROLE two_web_app WITH BYPASSRLS;",
    "ALTER USER two_web_app WITH CREATEROLE;",
    "CREATE ROLE unexpected_role;",
    "DROP OWNED BY two_web_migrate;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO two_web_app;",
    "DO $$ BEGIN EXECUTE 'CREATE TABLE public.events (id integer)'; END $$;",
  ]) {
    assert.match(
      migration(
        `CREATE TABLE public.events (id integer primary key);${tableGrants}${forbidden}`,
      ).join("\n"),
      /role switching|role changes|ownership changes|default privileges|dynamic sql/i,
      forbidden,
    );
  }
});

test("treats nested SQL comments as token separators", () => {
  assert.match(
    migration("SET/* outer /* nested */ comment */ROLE two_web_migrate;").join("\\n"),
    /role switching/i,
  );
  assert.match(
    migration(
      "CREATE/* outer /* nested */ comment */TABLE public.events (id integer primary key);",
    ).join("\\n"),
    /missing reviewed runtime grant/i,
  );
});

test("rejects object-owner changes after creation", () => {
  assert.notDeepEqual(
    migration(`CREATE TABLE public.events (id integer primary key);${tableGrants}
      ALTER TABLE public.events OWNER TO other_role;`),
    [],
  );
});

test("rejects temporary and foreign-table creation outside the reviewed object census", () => {
  for (const sql of [
    "CREATE TEMP TABLE public.events (id integer);",
    "CREATE FOREIGN TABLE public.events (id integer) SERVER remote;",
    "IMPORT FOREIGN SCHEMA public FROM SERVER remote INTO public;",
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("rejects SELECT INTO table creation outside the object census", () => {
  for (const sql of [
    "SELECT 1 AS id INTO public.events;",
    "WITH source AS (SELECT 1 AS id) SELECT * INTO public.events FROM source;",
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("rejects temporary table, sequence, and view variants", () => {
  for (const sql of [
    "CREATE GLOBAL TEMP TABLE public.events (id integer);",
    "CREATE LOCAL TEMPORARY TABLE public.events (id integer);",
    "CREATE TEMP SEQUENCE public.events_id_seq;",
    "CREATE TEMP VIEW public.events_view AS SELECT 1 AS id;",
    "CREATE UNLOGGED SEQUENCE public.events_id_seq;",
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("rejects inherited or referenced sequence defaults outside the census", () => {
  for (const sql of [
    `CREATE TABLE public.events (id integer DEFAULT nextval('public.existing_seq'::regclass));${tableGrants}`,
    `CREATE TABLE public.events (LIKE public.source_events INCLUDING DEFAULTS);${tableGrants}`,
    `CREATE TABLE public.events (id integer) INHERITS (public.source_events);${tableGrants}`,
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("rejects security-sensitive DDL outside the runtime-rights census", () => {
  for (const sql of [
    "ALTER FUNCTION public.existing_fn SECURITY DEFINER;",
    "CREATE TRIGGER events_trigger BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.fn();",
    "CREATE RULE events_rule AS ON SELECT TO public.events DO INSTEAD SELECT 1;",
    "CREATE EXTENSION IF NOT EXISTS pg_cron;",
    "CREATE SERVER remote FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname 'x');",
    "CREATE POLICY events_policy ON public.events USING (true);",
    "ALTER POLICY events_policy ON public.events USING (false);",
    "DROP TRIGGER events_trigger ON public.events;",
    "ALTER TABLE public.events FORCE ROW LEVEL SECURITY;",
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("covers explicit sequences, identity columns, partitions, and views", () => {
  const missingRights = [
    "CREATE SEQUENCE public.events_id_seq;",
    "CREATE TABLE public.events (id bigint GENERATED BY DEFAULT AS IDENTITY primary key);",
    "CREATE TABLE public.events_archive PARTITION OF public.events FOR VALUES FROM (0) TO (10);",
    "CREATE VIEW public.events_view AS SELECT id FROM public.events;",
  ];
  for (const sql of missingRights) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("rejects sequence-generating forms outside CREATE TABLE column definitions", () => {
  for (const sql of [
    "ALTER TABLE public.events ADD COLUMN generated_id serial;",
    `CREATE TABLE public.events (LIKE public.source_events INCLUDING IDENTITY);${tableGrants}`,
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("requires identity-generated sequence rights in addition to table rights", () => {
  const identityTable =
    "CREATE TABLE public.events (id bigint GENERATED BY DEFAULT AS IDENTITY primary key);";
  assert.match(
    migration(`${identityTable}${tableGrants}`).join("\n"),
    /missing reviewed runtime grant.*events_id_seq/i,
  );
  assert.deepEqual(
    migration(`${identityTable}${tableGrants}
      GRANT USAGE ON SEQUENCE public.events_id_seq TO two_web_app;
      GRANT SELECT ON SEQUENCE public.events_id_seq TO two_web_app;`),
    [],
  );
});

test("censuses serial and identity type aliases, including catalog-qualified ones", () => {
  const sequenceGrants = `
      GRANT USAGE ON SEQUENCE public.events_id_seq TO two_web_app;
      GRANT SELECT ON SEQUENCE public.events_id_seq TO two_web_app;`;
  for (const column of [
    "id serial4 primary key",
    "id serial8 primary key",
    "id pg_catalog.serial primary key",
    "id int GENERATED ALWAYS AS IDENTITY primary key",
    "id int4 GENERATED BY DEFAULT AS IDENTITY primary key",
    "id pg_catalog.int8 GENERATED ALWAYS AS IDENTITY primary key",
  ]) {
    assert.match(
      migration(`CREATE TABLE public.events (${column});${tableGrants}`).join("\n"),
      /missing reviewed runtime grant.*events_id_seq/i,
      column,
    );
    assert.deepEqual(
      migration(`CREATE TABLE public.events (${column});${tableGrants}${sequenceGrants}`),
      [],
      column,
    );
  }
  for (const sql of [
    "ALTER TABLE public.events ADD COLUMN generated_id serial4;",
    "ALTER TABLE public.events ADD COLUMN generated_id serial8;",
  ]) {
    assert.notDeepEqual(migration(sql), [], sql);
  }
});

test("does not treat a view as an allowlisted table", () => {
  assert.notDeepEqual(migration(`CREATE VIEW public.events AS SELECT 1 AS id;${tableGrants}`), []);
});

test("rejects an implicit sequence whose reviewed rights are not fully stated", () => {
  assert.match(
    migration(`CREATE TABLE public.events (id bigserial primary key);${tableGrants}
      GRANT USAGE ON SEQUENCE public.events_id_seq TO two_web_app;`).join("\n"),
    /missing reviewed runtime grant/i,
  );
});

test("lexes E-strings with backslash escapes instead of hiding later statements", () => {
  // PostgreSQL terminates each E-string below and executes the DELETE grant;
  // a lexer that treats \' as a doubled quote swallows the grant instead.
  for (const select of ["SELECT E'abc\\\\\\'';", "SELECT E'a\\\\\\'b';", "SELECT e'x\\\\y';"]) {
    assert.match(
      migration(
        `CREATE TABLE public.events (id integer primary key);${tableGrants}${select}
        GRANT DELETE ON TABLE public.events TO two_web_app;`,
      ).join("\n"),
      /unreviewed runtime privilege/i,
      select,
    );
  }
  // An E that extends an identifier is not an escape-string prefix: nameE'..'
  // is an identifier plus a normal string, and later statements stay visible.
  assert.deepEqual(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}SELECT nameE'a''b';`,
    ),
    [],
  );
});

test("does not open a dollar quote inside a dollar-bearing identifier", () => {
  assert.match(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}
      SELECT * FROM t$x$; GRANT DELETE ON TABLE public.events TO two_web_app; SELECT $x$done$x$;`,
    ).join("\n"),
    /unreviewed runtime privilege/i,
  );
  // Real dollar quotes and parameters still lex: the semicolon inside $$..$$
  // must not split, and $1 must not open a quote.
  assert.deepEqual(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}
      SELECT $$a;b$$; SELECT $1;`,
    ),
    [],
  );
});

test("fails closed on unterminated strings, quotes, and comments", () => {
  for (const sql of [
    "SELECT 'abc;",
    "SELECT E'abc;",
    "SELECT $$abc;",
    'SELECT "abc;',
    "SELECT 1; /* abc",
  ]) {
    assert.match(
      migration(`CREATE TABLE public.events (id integer primary key);${tableGrants}${sql}`).join(
        "\n",
      ),
      /unterminated/i,
      sql,
    );
  }
  assert.deepEqual(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}SELECT 1; -- trailing comment`,
    ),
    [],
  );
});

test("censuses recursive views instead of passing them silently", () => {
  assert.match(
    migration(
      "CREATE RECURSIVE VIEW public.nums (n) AS VALUES (1) UNION ALL SELECT n+1 FROM nums WHERE n < 5;",
    ).join("\n"),
    /no reviewed runtime-rights entry for created view: public\.nums/i,
  );
});

test("rejects CREATE SCHEMA schema elements outside the object census", () => {
  for (const sql of [
    "CREATE SCHEMA sneaky CREATE TABLE t (id integer);",
    "CREATE SCHEMA sneaky CREATE TABLE t (id integer) GRANT SELECT ON t TO two_web_app;",
  ]) {
    assert.match(migration(sql).join("\n"), /CREATE SCHEMA/i, sql);
  }
});

test("censuses quoted serial and identity spellings", () => {
  const sequenceGrants = `
      GRANT USAGE ON SEQUENCE public.events_id_seq TO two_web_app;
      GRANT SELECT ON SEQUENCE public.events_id_seq TO two_web_app;`;
  for (const column of [
    'id "serial" primary key',
    'id "serial8" primary key',
    'id "pg_catalog"."serial" primary key',
    'id "int" GENERATED ALWAYS AS IDENTITY primary key',
    'id "int8" GENERATED BY DEFAULT AS IDENTITY primary key',
  ]) {
    assert.match(
      migration(`CREATE TABLE public.events (${column});${tableGrants}`).join("\n"),
      /missing reviewed runtime grant.*events_id_seq/i,
      column,
    );
    assert.deepEqual(
      migration(`CREATE TABLE public.events (${column});${tableGrants}${sequenceGrants}`),
      [],
      column,
    );
  }
  assert.notDeepEqual(migration('ALTER TABLE public.events ADD COLUMN generated_id "serial";'), []);
});

test("rejects quoted set_config role switching", () => {
  assert.match(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}SELECT "set_config"('role', 'two_web_migrate', true);`,
    ).join("\n"),
    /role switching/i,
  );
});

function gitFixture() {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "rights-discovery-"),
  );
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  git("init", "-b", "main", ".");
  mkdirSync(join(dir, "drizzle"), { recursive: true });
  return { dir, git };
}

test("changed-migration discovery names the offending file", () => {
  const { dir, git } = gitFixture();
  try {
    writeFileSync(
      join(dir, "drizzle", "1000_base.sql"),
      `CREATE TABLE public.events (id integer primary key);\n${tableGrants}`,
    );
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(
      join(dir, "drizzle", "1001_bad.sql"),
      "CREATE TABLE public.events (id integer primary key);\n",
    );
    git("add", ".");
    git("commit", "-m", "bad");
    assert.deepEqual(changedMigrationFiles(base, dir), ["drizzle/1001_bad.sql"]);
    const failures = checkChangedMigrations(base, dir);
    assert.match(failures.join("\n"), /1001_bad\.sql/);
    assert.match(failures.join("\n"), /missing reviewed runtime grant/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changed-migration discovery passes and counts a reviewed migration", () => {
  const { dir, git } = gitFixture();
  try {
    writeFileSync(join(dir, "drizzle", "1000_base.sql"), "SELECT 1;\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(
      join(dir, "drizzle", "1001_good.sql"),
      `CREATE TABLE public.events (id integer primary key);\n${tableGrants}`,
    );
    git("add", ".");
    git("commit", "-m", "good");
    assert.deepEqual(changedMigrationFiles(base, dir), ["drizzle/1001_good.sql"]);
    assert.deepEqual(checkChangedMigrations(base, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows only the reviewed per-role sequence default ACL", () => {
  const identity = {
    object_type: "S",
    schema_name: "public",
    grantee: "two_web_app",
    grantor: "migration_login",
    current_user: "migration_login",
    is_grantable: false,
  };
  assert.deepEqual(
    validateDefaultAclRows([
      { ...identity, privilege_type: "USAGE" },
      { ...identity, privilege_type: "SELECT" },
    ]),
    [],
  );
  for (const row of [
    { ...identity, object_type: "r", privilege_type: "SELECT" },
    { ...identity, grantee: "PUBLIC", privilege_type: "USAGE" },
    { ...identity, privilege_type: "UPDATE" },
    { ...identity, is_grantable: true, privilege_type: "SELECT" },
    { ...identity, grantor: "other_role", privilege_type: "SELECT" },
  ]) {
    assert.match(validateDefaultAclRows([row]).join("\n"), /unreviewed default ACL/i);
  }
});
