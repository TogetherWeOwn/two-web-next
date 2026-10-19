import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_SEQUENCES,
  EXPECTED_TABLES,
  QUERIES,
  SECRET_NAME,
  assertReadOnly,
  checkSequenceNames,
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
