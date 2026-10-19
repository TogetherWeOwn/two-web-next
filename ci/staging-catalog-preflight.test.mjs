import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import {
  EXPECTED_SEQUENCES,
  EXPECTED_TABLES,
  QUERIES,
  SECRET_NAME,
  assertReadOnly,
  checkSequenceNames,
  safePreflightError,
  validateStagingUrl,
} from "./staging-catalog-preflight.mjs";
import {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  PLANETSCALE_STAGING_BRANCH_ID,
  PLANETSCALE_STAGING_HOST,
} from "./db-migrate.mjs";

const staging = (user = `role-stub.${PLANETSCALE_STAGING_BRANCH_ID}`, extra = "") =>
  `postgres://${user}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require${extra}`;

test("exactly seven hardcoded queries, fixed purpose, no inputs", () => {
  assert.equal(QUERIES.length, 7);
  assert.deepEqual(
    QUERIES.map((query) => query.id),
    [
      "table_owners",
      "sequences",
      "schema_acl",
      "create_booleans",
      "table_grants",
      "default_acl",
      "owner_counts",
    ],
  );
  assert.deepEqual(EXPECTED_TABLES, [
    "join_attempts",
    "web_oauth_journeys",
    "web_sessions",
    "web_throttle_hits",
  ]);
  assert.deepEqual(EXPECTED_SEQUENCES, ["join_attempts_id_seq", "web_throttle_hits_id_seq"]);
  assert.equal(SECRET_NAME, "PLANETSCALE_STAGING_DATABASE_URL");
});

test("every query is a single SELECT with no write statement", () => {
  for (const query of QUERIES) {
    assert.equal(assertReadOnly(query.sql), true);
    // Same verb+object pairing as the no-runtime-DDL guard: prose table
    // names such as role_table_grants must not trip it.
    assert.doesNotMatch(query.sql, /grant\s+\S+\s+on/i);
    assert.doesNotMatch(query.sql, /revoke\s+\S+\s+on/i);
  }
});

test("read-only fence rejects writes, stacked statements and non-SELECTs", () => {
  for (const sql of [
    "GRANT SELECT ON TABLE public.join_attempts TO two_web_app",
    "REVOKE CREATE ON SCHEMA public FROM two_web_app",
    "ALTER TABLE public.join_attempts OWNER TO someone",
    "SELECT 1; DROP TABLE public.join_attempts",
    "SHOW statement_timeout",
    "SET statement_timeout = '30s'",
    "BEGIN READ ONLY",
  ]) {
    assert.throws(() => assertReadOnly(sql), /SELECT-only/);
  }
});

test("staging endpoint pin accepts the pinned staging branch only", () => {
  const url = validateStagingUrl(staging());
  assert.equal(url.hostname, PLANETSCALE_STAGING_HOST);
  assert.equal(url.port, "5432");
});

test("endpoint pin refuses production identity, other hosts and weak TLS", () => {
  // Production host with a staging-looking role still refuses.
  assert.throws(
    () =>
      validateStagingUrl(
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}:s@${PLANETSCALE_PRODUCTION_HOST}/db?sslmode=require`,
      ),
    /production/,
  );
  // Staging host with the production branch id still refuses.
  assert.throws(
    () => validateStagingUrl(staging(`role.${PLANETSCALE_PRODUCTION_BRANCH_ID}`)),
    /production/,
  );
  // Retired Neon and unknown hosts refuse without naming values.
  assert.throws(
    () =>
      validateStagingUrl("postgres://u:s@ep-neon-123.us-east-2.aws.neon.tech/db?sslmode=require"),
    /pinned staging endpoint/,
  );
  assert.throws(() => validateStagingUrl(""), /Missing .* no fallback/);
  assert.throws(
    () =>
      validateStagingUrl(
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}:s@${PLANETSCALE_STAGING_HOST}/db`,
      ),
    /TLS/,
  );
  assert.throws(
    () =>
      validateStagingUrl(
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`,
      ),
    /TLS/,
  );
});

test("create_booleans uses (role, schema, privilege) order, lowercase public, missing-role guard", () => {
  const query = QUERIES.find((entry) => entry.id === "create_booleans").sql;
  assert.match(query, /has_schema_privilege\('two_web_app', 'public', 'CREATE'\)/);
  assert.match(query, /has_schema_privilege\('public', 'public', 'CREATE'\)/);
  assert.doesNotMatch(query, /'PUBLIC'/);
  assert.match(query, /EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'two_web_app'\)/);
  assert.equal(assertReadOnly(query), true);
});

test("table_grants reads raw relacl, not the membership-filtered information_schema view", () => {
  const query = QUERIES.find((entry) => entry.id === "table_grants").sql;
  assert.doesNotMatch(query, /information_schema/);
  assert.match(query, /aclexplode\(c\.relacl\)/);
  assert.match(query, /e\.grantee = 0/);
  // No membership probe: the read must report the same grants to a
  // non-member reader as to the owner (pinned live under SET ROLE below).
  assert.doesNotMatch(query, /pg_has_role/);
  assert.equal(assertReadOnly(query), true);
});

test("default_acl includes global (namespace 0) entries with an explicit label", () => {
  const query = QUERIES.find((entry) => entry.id === "default_acl").sql;
  assert.match(query, /defaclnamespace = 0/);
  assert.match(query, /\(global\)/);
  assert.equal(assertReadOnly(query), true);
});

test("driver errors are masked; only refusal prefixes pass through", () => {
  const driver = new Error(
    "connect failed postgres://role-stub:secret-value@db.host/db?sslmode=require",
  );
  const masked = safePreflightError(driver);
  assert.match(masked, /database details withheld/);
  assert.doesNotMatch(masked, /secret-value|postgres:\/\//);
  for (const message of [
    "Missing PLANETSCALE_STAGING_DATABASE_URL Environment secret; no fallback is permitted.",
    "Invalid preflight endpoint; value withheld.",
    "Refusing preflight against the production database; value withheld.",
    "Preflight requires the pinned staging endpoint with TLS; value withheld.",
    "This preflight takes no inputs.",
  ]) {
    assert.equal(safePreflightError(new Error(message)), message);
  }
});

test("endpoint pin refuses weak TLS, unknown params and bad shapes; strips channel_binding", () => {
  const staged = (query) =>
    `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db${query}`;
  // Only require/verify-full pass; disable and other values refuse.
  for (const sslmode of ["disable", "prefer", "verify-ca", "allow"]) {
    assert.throws(() => validateStagingUrl(staged(`?sslmode=${sslmode}`)), /TLS/);
  }
  // Unknown query params refuse: postgres.js would spread them over
  // connection settings and silently override the script's own guards.
  assert.throws(() => validateStagingUrl(staged("?sslmode=require&statement_timeout=5s")), /TLS/);
  // Bad protocol, hash, non-5432 port and non-database paths refuse.
  assert.throws(
    () =>
      validateStagingUrl(
        `http://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`,
      ),
    /Invalid preflight endpoint/,
  );
  assert.throws(
    () => validateStagingUrl(`${staged("?sslmode=require")}#fragment`),
    /Invalid preflight endpoint/,
  );
  assert.throws(
    () =>
      validateStagingUrl(
        `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}:5433/db?sslmode=require`,
      ),
    /Invalid preflight endpoint/,
  );
  assert.throws(
    () =>
      validateStagingUrl(
        `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/a/b?sslmode=require`,
      ),
    /Invalid preflight endpoint/,
  );
  // Only unknown channel_binding values refuse; known ones are accepted
  // and stripped (libpq-only flag; TLS stays enforced via sslmode).
  for (const binding of ["bogus", "prefer&channel_binding=bogus"]) {
    assert.throws(
      () => validateStagingUrl(staged(`?sslmode=require&channel_binding=${binding}`)),
      /channel binding/,
    );
  }
  for (const binding of ["require", "prefer", "disable"]) {
    const url = validateStagingUrl(staged(`?sslmode=require&channel_binding=${binding}`));
    assert.equal(url.searchParams.has("channel_binding"), false);
    assert.equal(url.searchParams.get("sslmode"), "require");
    assert.equal(url.port, "5432");
  }
});

const LIVE_URL = (() => {
  // Explicit opt-in only. Never fall back to DATABASE_URL: the fixture
  // roles below are cluster-wide, and a developer's ordinary local app
  // database would match a localhost allowlist while holding real roles.
  const raw = process.env.CATALOG_PREFLIGHT_TEST_DATABASE_URL;
  if (!raw) return null;
  try {
    if (
      ["localhost", "127.0.0.1", "::1", "agent-testdb", "postgres"].includes(new URL(raw).hostname)
    ) {
      return raw;
    }
  } catch {
    // Not a URL: not a live target.
  }
  return null;
})();

test("live: all seven queries execute on disposable Postgres and report the seeded grants", {
  skip: LIVE_URL
    ? false
    : "needs CATALOG_PREFLIGHT_TEST_DATABASE_URL on disposable Postgres (localhost/agent-testdb)",
}, async (t) => {
  const admin = postgres(LIVE_URL, { max: 1 });
  const dbName = `catalog_preflight_${process.pid}`;
  try {
    // Roles are cluster-wide, so a pre-existing fixture name means a leaked
    // run or a real local role: skip instead of dropping what we did not create.
    const existing = await admin.unsafe(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('two_web_app', 'preflight_owner', 'preflight_reader')",
    );
    if (existing.length > 0) {
      t.skip(
        `refusing live test: fixture role(s) already exist: ${existing.map((row) => row.rolname).join(", ")}`,
      );
      return;
    }
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const liveBase = new URL(LIVE_URL);
  liveBase.pathname = `/${dbName}`;
  const client = postgres(liveBase.href, { max: 1 });
  try {
    await client.unsafe("CREATE ROLE two_web_app NOLOGIN");
    await client.unsafe("CREATE ROLE preflight_owner NOLOGIN");
    await client.unsafe("CREATE ROLE preflight_reader NOLOGIN");
    await client.unsafe("GRANT CREATE ON SCHEMA public TO preflight_owner");
    // Discriminating C2 seed: the app role holds CREATE, PUBLIC does not.
    // The REVOKE keeps that pair exact on every Postgres major (pre-15
    // clusters grant PUBLIC CREATE on public by default).
    await client.unsafe("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.unsafe("GRANT CREATE ON SCHEMA public TO two_web_app");
    for (const table of EXPECTED_TABLES.filter((name) => name !== "web_throttle_hits")) {
      await client.unsafe(`CREATE TABLE ${table} (id bigserial primary key)`);
    }
    await client.unsafe("GRANT SELECT, INSERT ON TABLE public.join_attempts TO two_web_app");
    await client.unsafe("GRANT SELECT ON TABLE public.web_sessions TO PUBLIC");
    await client.unsafe("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC");
    await client.unsafe(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO PUBLIC",
    );
    // web_throttle_hits belongs to a role the reader is not a member of:
    // only its owner may grant on it.
    await client.unsafe("SET ROLE preflight_owner");
    try {
      await client.unsafe("CREATE TABLE web_throttle_hits (id bigserial primary key)");
      await client.unsafe("GRANT SELECT ON TABLE public.web_throttle_hits TO two_web_app");
    } finally {
      await client.unsafe("RESET ROLE");
    }

    const rows = {};
    await client.unsafe("BEGIN READ ONLY");
    try {
      // Read as an unrelated non-member role, like the staging preflight
      // connection: a membership-filtered grant read must fail here, not
      // pass silently on superuser visibility. SET LOCAL resets on COMMIT.
      await client.unsafe("SET LOCAL ROLE preflight_reader");
      for (const query of QUERIES) {
        rows[query.id] = await client.unsafe(query.sql);
      }
      await client.unsafe("COMMIT");
    } catch (error) {
      try {
        await client.unsafe("ROLLBACK");
      } catch {
        // Best-effort; the original error carries the verdict.
      }
      throw error;
    }

    assert.equal(rows.table_owners.length, 4);
    assert.deepEqual(
      rows.table_owners.map((row) => row.object).sort(),
      [...EXPECTED_TABLES].sort(),
    );
    assert.equal(rows.schema_acl.length, 1);
    const seen = new Set(
      rows.table_grants.map((row) => `${row.grantee}|${row.object}|${row.privilege_type}`),
    );
    for (const grant of [
      "two_web_app|join_attempts|SELECT",
      "two_web_app|join_attempts|INSERT",
      "PUBLIC|web_sessions|SELECT",
      "two_web_app|web_throttle_hits|SELECT",
    ]) {
      assert.ok(seen.has(grant), `expected grant row ${grant}`);
    }
    assert.equal(rows.create_booleans.length, 1);
    assert.equal(rows.create_booleans[0].app_has_create, true);
    assert.equal(rows.create_booleans[0].public_has_create, false);
    const schemas = new Set(rows.default_acl.map((row) => row.schema));
    assert.ok(schemas.has("(global)"), "global default privileges are reported");
    assert.ok(schemas.has("public"), "schema-scoped default privileges are reported");
    const c3 = checkSequenceNames(rows.sequences.map((row) => row.name));
    assert.equal(c3.mismatch, false);
    assert.deepEqual(c3.missing, []);
    assert.equal(
      rows.owner_counts.reduce((sum, row) => sum + Number(row.tables), 0),
      4,
    );

    // A missing two_web_app role reports NULL instead of aborting the run.
    await client.unsafe("DROP OWNED BY two_web_app");
    await client.unsafe("DROP ROLE two_web_app");
    const missing = await client.unsafe(
      QUERIES.find((query) => query.id === "create_booleans").sql,
    );
    assert.equal(missing.length, 1);
    assert.equal(missing[0].app_has_create, null);
    assert.equal(typeof missing[0].public_has_create, "boolean");
  } finally {
    await client.end({ timeout: 5 });
    const cleanup = postgres(LIVE_URL, { max: 1 });
    try {
      await cleanup.unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      // Safe: the existence gate above proved these names were absent, so
      // every role dropped here was created by this run.
      for (const role of ["two_web_app", "preflight_owner", "preflight_reader"]) {
        try {
          await cleanup.unsafe(`DROP ROLE "${role}"`);
        } catch {
          // Already gone or still referenced; the run-owned database is dropped.
        }
      }
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  }
});

test("C3 check passes on bigserial defaults and flags any divergence", () => {
  const ok = checkSequenceNames([...EXPECTED_SEQUENCES, "unrelated_seq"]);
  assert.equal(ok.mismatch, false);
  assert.deepEqual(ok.missing, []);
  const missing = checkSequenceNames(["join_attempts_id_seq"]);
  assert.equal(missing.mismatch, true);
  assert.deepEqual(missing.missing, ["web_throttle_hits_id_seq"]);
  const renamed = checkSequenceNames(["join_attempts_id_seq", "web_throttle_hits_seq"]);
  assert.equal(renamed.mismatch, true);
  assert.deepEqual(renamed.missing, ["web_throttle_hits_id_seq"]);
  assert.ok(renamed.extra.includes("web_throttle_hits_seq"));
});
