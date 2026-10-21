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
      /role switching|SET is forbidden|RESET is forbidden|role changes|ownership changes|default privileges|dynamic sql/i,
      forbidden,
    );
  }
});

test("treats nested SQL comments as token separators", () => {
  assert.match(
    migration("SET/* outer /* nested */ comment */ROLE two_web_migrate;").join("\\n"),
    /SET is forbidden/i,
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

test("does not open a dollar quote after digits or non-ASCII identifier characters", () => {
  // PostgreSQL lexes t1$x$ and e-caron$x$ as single identifiers (probed
  // column names); a scanner that opens $x$ after a digit or a non-ASCII
  // letter swallows the GRANT instead of reporting it.
  for (const sandwich of [
    "SELECT 1 AS t1$x$; GRANT DELETE ON TABLE public.events TO two_web_app; SELECT $x$done$x$;",
    "SELECT 1 AS \u011b$x$; GRANT DELETE ON TABLE public.events TO two_web_app; SELECT 1 AS \u011b$x$;",
  ]) {
    assert.match(
      migration(
        `CREATE TABLE public.events (id integer primary key);${tableGrants}${sandwich}`,
      ).join("\n"),
      /unreviewed runtime privilege/i,
      sandwich,
    );
  }
  // Non-ASCII dollar-quote tags still lex: the semicolon inside the
  // e-caron tag below must not split.
  assert.deepEqual(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}SELECT $\u011b$a;b$\u011b$;`,
    ),
    [],
  );
});

test("treats an identifier-extended E as a plain-string prefix", () => {
  // x1e is one identifier to PostgreSQL, so x1e'\' is a plain string and the
  // DELETE grant executes; an E-string reading would swallow it. (A bare
  // digit directly before E, 1E'...', is a PostgreSQL "trailing junk" error,
  // so the plain-string reading fails closed there too.)
  assert.match(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}CREATE DOMAIN x1e AS text; SELECT x1e'\\'; GRANT DELETE ON TABLE public.events TO two_web_app; -- '`,
    ).join("\n"),
    /unreviewed runtime privilege/i,
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

test("rejects session configuration statements without an allowlist", () => {
  for (const forbidden of [
    "SET ROLE two_web_migrate;",
    "SET \"role\" = 'two_web_migrate';",
    "SET SESSION \"role\" = 'two_web_migrate';",
    "SET LOCAL \"Role\" = 'two_web_migrate';",
    "SET SESSION AUTHORIZATION two_web_migrate;",
    "SET session_authorization = 'two_web_migrate';",
    "SET \"session_authorization\" = 'two_web_migrate';",
    "SET standard_conforming_strings = off;",
    "SET search_path = public;",
    "SET statement_timeout = 1000;",
    "RESET ROLE;",
    "RESET SESSION AUTHORIZATION;",
    "RESET standard_conforming_strings;",
    "RESET ALL;",
    "DISCARD ALL;",
    "DISCARD PLANS;",
  ]) {
    assert.match(
      migration(
        `CREATE TABLE public.events (id integer primary key);${tableGrants}${forbidden}`,
      ).join("\n"),
      /SET is forbidden|RESET is forbidden|DISCARD is forbidden/i,
      forbidden,
    );
  }
  // Read-only SHOW and UPDATE ... SET are not session configuration.
  assert.deepEqual(
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}SHOW standard_conforming_strings; UPDATE public.events SET title = 'x' WHERE id = 1;`,
    ),
    [],
  );
});

test("rejects the standard_conforming_strings escape sandwich, including the breakpoint form", () => {
  const sandwich = (separator) =>
    `SET standard_conforming_strings = off;${separator}SELECT 'abc\\'';${separator}GRANT DELETE ON TABLE public.events TO two_web_app;${separator}SELECT 'x';${separator}-- '`;
  for (const sql of [sandwich(" "), sandwich("\n--> statement-breakpoint\n")]) {
    assert.match(
      migration(`CREATE TABLE public.events (id integer primary key);${tableGrants}${sql}`).join(
        "\n",
      ),
      /SET is forbidden/i,
    );
  }
});

test("rejects persisted configuration changes", () => {
  for (const forbidden of [
    "ALTER DATABASE mydb SET standard_conforming_strings = off;",
    "ALTER DATABASE mydb RESET search_path;",
    "ALTER SYSTEM SET standard_conforming_strings = off;",
  ]) {
    assert.match(
      migration(
        `CREATE TABLE public.events (id integer primary key);${tableGrants}${forbidden}`,
      ).join("\n"),
      /ALTER DATABASE configuration defaults|ALTER SYSTEM/i,
      forbidden,
    );
  }
});

test("censuses non-ASCII identifiers instead of passing them silently", () => {
  assert.match(
    migration("CREATE TABLE public.\u011bt (id integer primary key);").join("\n"),
    /no reviewed runtime-rights entry for created table/i,
  );
  // A non-ASCII letter after a type name keeps it one identifier: serial +
  // e-caron is not a serial column, so no sequence grants are required.
  assert.deepEqual(
    migration(
      `CREATE TABLE public.events (id2 serial\u011b, id integer primary key);${tableGrants}`,
    ),
    [],
  );
  // A trailing non-ASCII letter must not truncate the census to the ASCII
  // prefix: public.events + e-caron is a distinct table the reviewed
  // public.events grants do not cover. An ASCII-only census identifier
  // matches the events prefix and returns [] here, so these suffix forms
  // pin that line.
  assert.match(
    migration(`CREATE TABLE public.events\u011b (id integer primary key);${tableGrants}`).join(
      "\n",
    ),
    /no reviewed runtime-rights entry for created table: public\.events\u011b/,
  );
  // A non-ASCII serial column name owns a distinct backing sequence that
  // must be censused too.
  assert.match(
    migration(
      `CREATE TABLE public.events (id\u011b serial, id integer primary key);${tableGrants}
      GRANT USAGE ON SEQUENCE public.events_id_seq TO two_web_app;
      GRANT SELECT ON SEQUENCE public.events_id_seq TO two_web_app;`,
    ).join("\n"),
    /no reviewed runtime-rights entry for created sequence: public\.events_id\u011b_seq/,
  );
});

test("rejects E-string newline continuation instead of hiding later statements", () => {
  // PostgreSQL concatenates a string literal with a following bare literal
  // across a newline gap and inherits the first literal's escape mode, so
  // lexing the second segment as a plain string swallows the GRANT below
  // while PostgreSQL applies it (relacl two_web_app=d). The guard rejects
  // the shape instead. All three payloads returned [] pre-fix.
  const hiddenDelete = (gap) =>
    migration(
      `CREATE TABLE public.events (id integer primary key);${tableGrants}SELECT E'x'${gap}'a\\'b'; GRANT DELETE ON TABLE public.events TO two_web_app; SELECT 'y'; -- '`,
    ).join("\n");
  assert.match(hiddenDelete("\n"), /E-string newline continuation is not supported/);
  assert.match(hiddenDelete(" -- c\n"), /E-string newline continuation is not supported/);
  // A block comment in the gap breaks continuation in PostgreSQL (the chunk
  // then fails there), but the split scanner sees comment-stripped text
  // where the comment has become a space, so it rejects the ambiguous gap
  // rather than risk inheriting wrongly.
  assert.match(hiddenDelete(" /* c */\n"), /E-string newline continuation is not supported/);
});

test("allows plain-string continuation and separated E-strings", () => {
  const table = `CREATE TABLE public.events (id integer primary key);${tableGrants}`;
  // Plain-plus-plain continuation lexes identically with or without
  // inheritance, so it stays allowed.
  assert.deepEqual(migration(`${table}SELECT 'a'\n'b';`), []);
  // No newline gap, or the newline stays inside one literal: nothing to
  // continue.
  assert.deepEqual(migration(`${table}SELECT E'a', E'b';`), []);
  assert.deepEqual(migration(`${table}SELECT E'a\nb';`), []);
  // A second E prefix breaks continuation in PostgreSQL (the chunk fails
  // there), so passing fails closed like the other PG-error shapes.
  assert.deepEqual(migration(`${table}SELECT E'a'\nE'b';`), []);
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
