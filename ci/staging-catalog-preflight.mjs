// Fixed-purpose staging catalog preflight (read-only).
//
// Reads the seven staging catalog facts the standing-migrator cutover needs,
// using the EXISTING staging-environment secret in place: no copy, no new
// credential, no mint/rotate. No inputs: no target/branch/SQL parameters, no
// dispatch of the migrate workflow (target=staging there still runs plan
// THEN APPLY; there is no plan-only input).
//
// Safety: hardcoded SELECTs only, one READ ONLY transaction, statement and
// lock timeouts at the connection and transaction level, staging-endpoint
// pin (same PlanetScale staging host/branch pins as ci/db-migrate.mjs),
// TLS required, max one connection. Output is restricted to the requested
// role/object/ACL/count/boolean rows; the secret value is never printed,
// written, or included in errors.
//
// Manual dispatch only via .github/workflows/staging-catalog-preflight.yml
// (staging environment, reviewed main only). Direct local runs need
// PLANETSCALE_STAGING_DATABASE_URL in the environment; `--selftest` runs
// the DB-free checks below.
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  PLANETSCALE_STAGING_BRANCH_ID,
  PLANETSCALE_STAGING_HOST,
} from "./db-migrate.mjs";

export const SECRET_NAME = "PLANETSCALE_STAGING_DATABASE_URL";

export const EXPECTED_TABLES = [
  "join_attempts",
  "web_oauth_journeys",
  "web_sessions",
  "web_throttle_hits",
];

export const EXPECTED_SEQUENCES = ["join_attempts_id_seq", "web_throttle_hits_id_seq"];

// Exactly seven hardcoded reads. IDs are stable output keys.
export const QUERIES = [
  {
    id: "table_owners",
    sql: "SELECT tablename AS object, tableowner AS owner FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('join_attempts', 'web_oauth_journeys', 'web_sessions', 'web_throttle_hits') ORDER BY 1",
  },
  {
    id: "sequences",
    sql: "SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1",
  },
  {
    id: "schema_acl",
    sql: "SELECT nspname AS schema, nspacl AS acl FROM pg_namespace WHERE nspname = 'public'",
  },
  {
    id: "create_booleans",
    // has_schema_privilege(user, schema, privilege): the pseudo-role is only
    // the lowercase name 'public' ('PUBLIC' errors as a missing role), and a
    // missing two_web_app role reports NULL instead of aborting the run.
    sql: "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'two_web_app') THEN has_schema_privilege('two_web_app', 'public', 'CREATE') ELSE NULL END AS app_has_create, has_schema_privilege('public', 'public', 'CREATE') AS public_has_create",
  },
  {
    id: "table_grants",
    // Raw relacl, not information_schema.role_table_grants: that view only
    // shows rows whose grantor/grantee is in the reader's enabled_roles, so
    // grants from a non-member owner would read as zero rows. relacl is
    // visible regardless of membership; grantee 0 is PUBLIC. No regrole
    // casts, so a missing two_web_app role filters to nothing instead of
    // erroring.
    sql: "SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee, c.relname AS object, e.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN aclexplode(c.relacl) AS e WHERE n.nspname = 'public' AND c.relname IN ('join_attempts', 'web_oauth_journeys', 'web_sessions', 'web_throttle_hits') AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) = 'two_web_app') ORDER BY 1, 2, 3",
  },
  {
    id: "default_acl",
    // Include global default privileges (defaclnamespace = 0): an ALTER
    // DEFAULT PRIVILEGES without IN SCHEMA governs later tables in public
    // but the schema-scoped predicate alone would hide it.
    sql: "SELECT CASE WHEN defaclnamespace = 0 THEN '(global)' ELSE defaclnamespace::regnamespace::text END AS schema, defaclrole::regrole::text AS for_role, defaclobjtype AS objtype, defaclacl AS acl FROM pg_default_acl WHERE defaclnamespace = 0 OR defaclnamespace = 'public'::regnamespace",
  },
  {
    id: "owner_counts",
    sql: "SELECT tableowner AS owner, count(*) AS tables FROM pg_tables WHERE schemaname = 'public' GROUP BY 1 ORDER BY 1",
  },
];

// SELECT-only fence for the hardcoded queries above. Full-line `//`
// comments may discuss writes; an inline write statement never appears.
const WRITE_PATTERN =
  /\b(insert|update|delete|merge|grant|revoke|alter|create|drop|truncate|copy|call|vacuum|analyze|cluster|comment|security|owned|execute|handler|import|listen|load|unlisten|reassign|refresh|discard|prepare|deallocate|set|reset|begin|commit|rollback|savepoint|lock|checkpoint|reindex)\b/i;

export function assertReadOnly(sql) {
  const text = String(sql).trim();
  if (!/^select\b/i.test(text)) throw new Error("Preflight queries must be SELECT-only.");
  // The C2 query names the quoted 'CREATE' privilege literal; statement
  // verbs are what matter, so string literals are blanked before the check.
  const code = text.replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.)*"/g, '""');
  if (WRITE_PATTERN.test(code)) throw new Error("Preflight queries must be SELECT-only.");
  if (text.includes(";")) throw new Error("Preflight queries must be single statements.");
  return true;
}

const branchIdOf = (username) =>
  String(username ?? "")
    .split(".")
    .pop() ?? "";

function refuse(message) {
  throw new Error(message);
}

// Same endpoint pins as the migrate path: the username suffix carries the
// PlanetScale branch id, the host pin keeps a mis-provisioned production
// endpoint out. Messages never include the URL value.
export function validateStagingUrl(raw) {
  if (!raw) refuse(`Missing ${SECRET_NAME} Environment secret; no fallback is permitted.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    refuse("Invalid preflight URL; value withheld.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)
  ) {
    refuse("Invalid preflight endpoint; value withheld.");
  }
  const productionIdentity =
    /^[a-z0-9-]+\.pg\.psdb\.cloud$/.test(url.hostname) &&
    (url.hostname === PLANETSCALE_PRODUCTION_HOST ||
      branchIdOf(url.username) === PLANETSCALE_PRODUCTION_BRANCH_ID);
  if (productionIdentity)
    refuse("Refusing preflight against the production database; value withheld.");
  if (
    url.hostname !== PLANETSCALE_STAGING_HOST ||
    branchIdOf(url.username) !== PLANETSCALE_STAGING_BRANCH_ID
  ) {
    refuse("Preflight requires the pinned staging endpoint with TLS; value withheld.");
  }
  if (
    !url.username ||
    !url.password ||
    !["require", "verify-full"].includes(url.searchParams.get("sslmode")) ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
  ) {
    refuse("Preflight requires a direct endpoint with TLS; value withheld.");
  }
  const bindings = url.searchParams.getAll("channel_binding");
  if (bindings.some((value) => !["require", "prefer", "disable"].includes(value))) {
    refuse("Invalid channel binding option; value withheld.");
  }
  // postgres.js forwards unknown URL options as startup settings, not libpq
  // flags, and does not implement SCRAM channel binding. Strip the
  // libpq-only flag here; TLS stays enforced via sslmode + rejectUnauthorized.
  url.searchParams.delete("channel_binding");
  url.port = "5432";
  return url;
}

// C3 fail-closed helper: the cutover aborts when live sequence names differ
// from the bigserial defaults. The preflight flags the difference; it never
// substitutes names by guess.
export function checkSequenceNames(actualNames) {
  const actual = [...new Set(actualNames)].sort();
  const expected = [...EXPECTED_SEQUENCES].sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const expectedSet = new Set(expected);
  const relevantExtra = actual.filter(
    (name) =>
      !expectedSet.has(name) &&
      (/^join_attempts/.test(name) || /^web_throttle/.test(name) || /_id_seq$/.test(name)),
  );
  return { expected, actual, missing, extra: relevantExtra, mismatch: missing.length > 0 };
}

export function safePreflightError(error) {
  if (
    error instanceof Error &&
    /^(Missing|Invalid|Refusing|Preflight|This preflight)/.test(error.message)
  ) {
    return error.message;
  }
  // Never log driver errors: they can contain URLs, credentials, SQL or row data.
  return "Preflight failed; database details withheld. Stop and investigate with the authorized database operator; do not substitute credentials.";
}

function summarize(output) {
  const lines = [
    "### Staging catalog preflight (read-only, staging branch only)",
    "",
    `- tables: ${output.table_owners.map((row) => `${row.object}=${row.owner}`).join(", ") || "none of the 4 present"}`,
    `- sequences: ${output.sequences.map((row) => `${row.name}=${row.owner}`).join(", ") || "none"}`,
    `- C3 sequence names: ${output.c3.mismatch ? `MISMATCH (missing ${output.c3.missing.join(", ")})` : "match bigserial defaults"}`,
    `- C2 app_has_create=${output.c2.app_has_create} public_has_create=${output.c2.public_has_create}`,
    `- table grants: ${output.table_grants.length} row(s)`,
    `- default ACL: ${output.default_acl.length} row(s)`,
    `- owners: ${output.owner_counts.map((row) => `${row.owner}=${row.tables}`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

export async function runPreflight(env = process.env) {
  const url = validateStagingUrl(env[SECRET_NAME]);
  for (const query of QUERIES) assertReadOnly(query.sql);
  const client = postgres(url.href, {
    port: 5432,
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: 10,
    password: () => decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    connection: {
      statement_timeout: 30000,
      lock_timeout: 10000,
      search_path: "public",
      datestyle: "ISO, YMD",
    },
    onnotice: () => {},
  });
  try {
    const rows = {};
    await client.unsafe("BEGIN READ ONLY");
    try {
      await client.unsafe("SET LOCAL statement_timeout = '30s'");
      await client.unsafe("SET LOCAL lock_timeout = '10s'");
      for (const query of QUERIES) {
        rows[query.id] = await client.unsafe(query.sql);
      }
      await client.unsafe("COMMIT");
    } catch (error) {
      try {
        await client.unsafe("ROLLBACK");
      } catch {
        // The rollback is best-effort; the original error carries the verdict.
      }
      throw error;
    }
    const expectedSet = new Set(EXPECTED_SEQUENCES);
    const output = {
      table_owners: rows.table_owners,
      sequences: rows.sequences.filter((row) => expectedSet.has(row.name)),
      all_sequences: rows.sequences,
      schema_acl: rows.schema_acl,
      create_booleans: rows.create_booleans[0] ?? null,
      table_grants: rows.table_grants,
      default_acl: rows.default_acl,
      owner_counts: rows.owner_counts,
      c3: checkSequenceNames(rows.sequences.map((row) => row.name)),
      c2: rows.create_booleans[0] ?? null,
    };
    const text = JSON.stringify(output, null, 2);
    console.log(text);
    if (env.PREFLIGHT_OUTFILE) writeFileSync(env.PREFLIGHT_OUTFILE, `${text}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summarize(output)}\n`);
    return output;
  } finally {
    await client.end({ timeout: 5 });
  }
}

function selftest() {
  // DB-free: endpoint pin, read-only fence, C3 flag logic.
  validateStagingUrl(
    `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`,
  );
  if (QUERIES.length !== 7) throw new Error(`expected 7 queries, saw ${QUERIES.length}`);
  for (const query of QUERIES) assertReadOnly(query.sql);
  const ok = checkSequenceNames([...EXPECTED_SEQUENCES]);
  if (ok.mismatch) throw new Error("expected sequence defaults to match");
  const flagged = checkSequenceNames(["join_attempts_id_seq"]);
  if (!flagged.mismatch || !flagged.missing.includes("web_throttle_hits_id_seq")) {
    throw new Error("C3 check must flag a missing sequence");
  }
  console.log("staging-catalog-preflight selftest: PASS (7 queries, SELECT-only, C3 flags)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const isSelftest = args.length === 1 && args[0] === "--selftest";
  const isRun = args.length === 0;
  if (!isSelftest && !isRun) {
    console.error(
      "staging-catalog-preflight: usage: node ci/staging-catalog-preflight.mjs [--selftest]",
    );
    process.exitCode = 2;
  } else {
    try {
      if (isSelftest) selftest();
      else await runPreflight();
    } catch (error) {
      console.error(safePreflightError(error));
      process.exitCode = 1;
    }
  }
}
