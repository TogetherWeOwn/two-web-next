// Fixed-purpose staging NOLOGIN role bootstrap (check-then-create).
//
// Ensures the fixed application role exists before overlay GRANTs can apply,
// using the EXISTING staging-environment secret in place: no copy, no new
// credential, no mint/rotate. No inputs: no target/branch/SQL parameters, no
// dispatch of the migrate workflow.
//
// Safety: the check is one hardcoded SELECT on pg_roles and the only DDL the
// bootstrap may ever emit is the byte-exact CREATE_ROLE_DDL constant below
// (no grants, membership, ownership, ALTER, LOGIN, password, default ACL,
// schema/data changes or migration journal changes). Check first: a present
// compatible role is a no-op, an incompatible existing role is refused
// without any DDL. Staging-endpoint pin (same PlanetScale staging
// host/branch pins as ci/db-migrate.mjs), TLS required, max one connection,
// bounded statement/lock/connect timeouts; a duplicate-object (42710) race
// resolves to whatever is actually present. The secret value is never
// printed, written, or included in errors.
//
// Manual dispatch only via .github/workflows/staging-role-bootstrap.yml
// (staging environment, reviewed main only). Direct local runs need
// PLANETSCALE_STAGING_DATABASE_URL in the environment; `--selftest` runs
// the DB-free checks below.
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  PLANETSCALE_STAGING_BRANCH_ID,
  PLANETSCALE_STAGING_HOST,
} from "./db-migrate.mjs";

export const SECRET_NAME = "PLANETSCALE_STAGING_DATABASE_URL";
export const ROLE_NAME = "two_web_app";

// The ONLY DDL this bootstrap may ever emit: byte-exact, no semicolon, no
// variants. assertBootstrapDdl enforces the fence at every use site.
export const CREATE_ROLE_DDL = "CREATE ROLE two_web_app NOLOGIN";

// Single hardcoded status read for the fixed role. PostgreSQL CREATE ROLE
// defaults (NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
// NOBYPASSRLS, no password) are what classifyRole accepts as compatible.
// See https://www.postgresql.org/docs/current/sql-createrole.html
export const ROLE_STATUS_QUERY =
  "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolpassword, rolconnlimit FROM pg_roles WHERE rolname = 'two_web_app'";

export const STATEMENT_TIMEOUT_MS = 30000;
export const LOCK_TIMEOUT_MS = 10000;
export const CONNECT_TIMEOUT_SECONDS = 10;

export function assertBootstrapDdl(sql) {
  if (sql !== CREATE_ROLE_DDL) {
    throw new Error("Bootstrap permits only the fixed role DDL; value withheld.");
  }
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
  if (!raw || !String(raw).trim()) {
    refuse(`Missing ${SECRET_NAME} Environment secret; no fallback is permitted.`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    refuse("Invalid bootstrap URL; value withheld.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)
  ) {
    refuse("Invalid bootstrap endpoint; value withheld.");
  }
  const productionIdentity =
    /^[a-z0-9-]+\.pg\.psdb\.cloud$/.test(url.hostname) &&
    (url.hostname === PLANETSCALE_PRODUCTION_HOST ||
      branchIdOf(url.username) === PLANETSCALE_PRODUCTION_BRANCH_ID);
  if (productionIdentity) {
    refuse("Refusing bootstrap against the production database; value withheld.");
  }
  if (
    url.hostname !== PLANETSCALE_STAGING_HOST ||
    branchIdOf(url.username) !== PLANETSCALE_STAGING_BRANCH_ID
  ) {
    refuse("Bootstrap requires the pinned staging endpoint with TLS; value withheld.");
  }
  if (
    !url.username ||
    !url.password ||
    !["require", "verify-full"].includes(url.searchParams.get("sslmode")) ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
  ) {
    refuse("Bootstrap requires a direct endpoint with TLS; value withheld.");
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

// Compatible = exactly the PostgreSQL CREATE ROLE defaults the bootstrap
// creates: NOLOGIN, no elevated attributes, no password. Anything else is
// refused without changes; the reason names the offending attribute.
export function classifyRole(row) {
  if (!row) return { state: "absent" };
  if (row.rolcanlogin) return { state: "incompatible", reason: "existing role has LOGIN" };
  if (row.rolsuper) return { state: "incompatible", reason: "existing role is SUPERUSER" };
  if (row.rolcreatedb) return { state: "incompatible", reason: "existing role has CREATEDB" };
  if (row.rolcreaterole) {
    return { state: "incompatible", reason: "existing role has CREATEROLE" };
  }
  if (row.rolreplication) {
    return { state: "incompatible", reason: "existing role has REPLICATION" };
  }
  if (row.rolbypassrls) {
    return { state: "incompatible", reason: "existing role has BYPASSRLS" };
  }
  if (row.rolpassword) {
    return { state: "incompatible", reason: "existing role has a password" };
  }
  return { state: "compatible" };
}

async function readStatus(client) {
  try {
    return await client.unsafe(ROLE_STATUS_QUERY);
  } catch {
    // Never surface driver errors: they can contain URLs, credentials, SQL
    // or row data.
    throw new Error("Bootstrap status check failed; database details withheld.");
  }
}

function refuseIncompatible(verdict) {
  throw new Error(
    `Refusing bootstrap: ${verdict.reason ?? "incompatible role attributes"}; no changes made.`,
  );
}

export async function bootstrapRole(client) {
  const rows = await readStatus(client);
  const verdict = classifyRole(rows?.[0] ?? null);
  if (verdict.state === "incompatible") refuseIncompatible(verdict);
  if (verdict.state === "compatible") {
    return { outcome: "present", role: ROLE_NAME, ddlIssued: false };
  }
  assertBootstrapDdl(CREATE_ROLE_DDL);
  try {
    await client.unsafe(CREATE_ROLE_DDL);
  } catch (error) {
    // Concurrent create lost the race: the role now exists; re-read and
    // resolve to whatever is actually there instead of failing.
    if (error?.code === "42710") {
      const raced = await readStatus(client);
      const racedVerdict = classifyRole(raced?.[0] ?? null);
      if (racedVerdict.state === "compatible") {
        return { outcome: "present", role: ROLE_NAME, ddlIssued: false };
      }
      if (racedVerdict.state === "incompatible") refuseIncompatible(racedVerdict);
      throw new Error("Bootstrap lost the create race and the role is absent; details withheld.");
    }
    throw new Error("Bootstrap role creation failed; database details withheld.");
  }
  const verify = await readStatus(client);
  const verifyVerdict = classifyRole(verify?.[0] ?? null);
  if (verifyVerdict.state === "incompatible") refuseIncompatible(verifyVerdict);
  if (verifyVerdict.state !== "compatible") {
    throw new Error("Bootstrap verification failed; database details withheld.");
  }
  return { outcome: "created", role: ROLE_NAME, ddlIssued: true };
}

export function safeBootstrapError(error) {
  if (
    error instanceof Error &&
    /^(Missing|Invalid|Refusing|Bootstrap|This bootstrap)/.test(error.message)
  ) {
    return error.message;
  }
  // Never log driver errors: they can contain URLs, credentials, SQL or row data.
  return "Bootstrap failed; database details withheld. Stop and investigate with the authorized database operator; do not substitute credentials.";
}

export async function runBootstrap(env = process.env) {
  const url = validateStagingUrl(env[SECRET_NAME]);
  assertBootstrapDdl(CREATE_ROLE_DDL);
  const client = postgres(url.href, {
    port: 5432,
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    password: () => decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    connection: {
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      search_path: "public",
      datestyle: "ISO, YMD",
    },
    onnotice: () => {},
  });
  try {
    const evidence = await bootstrapRole(client);
    console.log(JSON.stringify(evidence));
    return evidence;
  } finally {
    await client.end({ timeout: 5 });
  }
}

function selftest() {
  // DB-free: endpoint pin, DDL fence, role classification, timeout bounds.
  validateStagingUrl(
    `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:stub@${PLANETSCALE_STAGING_HOST}/db?sslmode=require`,
  );
  for (const raw of ["", "   "]) {
    let refused = false;
    try {
      validateStagingUrl(raw);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("selftest: a missing secret must be refused");
  }
  assertBootstrapDdl(CREATE_ROLE_DDL);
  let fenced = false;
  try {
    assertBootstrapDdl(`${CREATE_ROLE_DDL};`);
  } catch {
    fenced = true;
  }
  if (!fenced) throw new Error("selftest: the DDL fence must refuse variants");
  if (classifyRole(null).state !== "absent" || classifyRole(undefined).state !== "absent") {
    throw new Error("selftest: a missing role must classify as absent");
  }
  const compatible = {
    rolcanlogin: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolpassword: null,
  };
  if (classifyRole(compatible).state !== "compatible") {
    throw new Error("selftest: NOLOGIN defaults must classify as compatible");
  }
  const login = classifyRole({ ...compatible, rolcanlogin: true });
  if (login.state !== "incompatible" || !/login/i.test(login.reason ?? "")) {
    throw new Error("selftest: LOGIN must classify as incompatible");
  }
  if (
    !/^select\b/i.test(ROLE_STATUS_QUERY.trim()) ||
    ROLE_STATUS_QUERY.includes(";") ||
    !ROLE_STATUS_QUERY.includes("pg_roles")
  ) {
    throw new Error("selftest: the status query must be a single SELECT on pg_roles");
  }
  for (const [name, value, max] of [
    ["STATEMENT_TIMEOUT_MS", STATEMENT_TIMEOUT_MS, 60000],
    ["LOCK_TIMEOUT_MS", LOCK_TIMEOUT_MS, 30000],
    ["CONNECT_TIMEOUT_SECONDS", CONNECT_TIMEOUT_SECONDS, 30],
  ]) {
    if (!Number.isInteger(value) || value <= 0 || value > max) {
      throw new Error(`selftest: ${name} out of bounds`);
    }
  }
  console.log("staging-role-bootstrap selftest: PASS (pin, DDL fence, classification, timeouts)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const isSelftest = args.length === 1 && args[0] === "--selftest";
  const isRun = args.length === 0;
  if (!isSelftest && !isRun) {
    console.error("staging-role-bootstrap: usage: node ci/staging-role-bootstrap.mjs [--selftest]");
    process.exitCode = 2;
  } else if (isSelftest) {
    try {
      selftest();
    } catch (error) {
      // Selftest diagnostics are hardcoded literals with no secrets; print
      // them verbatim instead of masking them as database failures.
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    try {
      await runBootstrap();
    } catch (error) {
      console.error(safeBootstrapError(error));
      process.exitCode = 1;
    }
  }
}
