// Shared TLS floor for the destructive operator CLIs (erase-member and
// revoke-sessions). Both commands delete or invalidate member data under the
// same threat model, so they share one parse/validate/client core: the erase
// floor. The TLS-verification override is refused on every host, a remote
// URL without verify-full TLS is refused (never silently defaulted), and
// remote client construction throws unless the effective TLS is verify-full.
// Each CLI keeps its own argv parser (usage text and refusal edges differ);
// everything that touches DATABASE_URL, TLS, or the driver lives here.
import { parseDatabaseUrl } from "./db-ping-core.mjs";

export const LOCAL_HOSTS = new Set(["agent-testdb", "localhost", "127.0.0.1", "::1"]);
export const TLS_OVERRIDE_REFUSAL =
  "Refusing: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification.";

/** Production-looking connection strings need `--target production`. */
export function isProductionDatabaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  let name = "";
  try {
    name = decodeURIComponent(url.pathname.slice(1)).toLowerCase();
  } catch {
    return false;
  }
  if (/(^|[.-])(prod|production)([.-]|$)/.test(host)) return true;
  if (name === "prod" || name === "production") return true;
  return false;
}

export function validateOperatorEnvironment(env, target) {
  const raw = env.DATABASE_URL;
  let endpoint;
  try {
    endpoint = parseDatabaseUrl(raw);
  } catch {
    throw new Error("Refusing: DATABASE_URL is missing or invalid.");
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error(TLS_OVERRIDE_REFUSAL);
  if (isProductionDatabaseUrl(raw) && target !== "production") {
    throw new Error("Refusing: production database without --target production.");
  }
  if (LOCAL_HOSTS.has(endpoint.host[0].toLowerCase().replace(/\.$/, "")))
    return { databaseUrl: raw };
  if (target !== "staging" && target !== "production")
    throw new Error("Refusing: remote database needs --target staging or --target production.");
  const url = new URL(raw);
  const mode = url.searchParams.get("sslmode");
  const verified = mode === "verify-full" || (mode === null && url.searchParams.has("sslrootcert"));
  if (!verified)
    throw new Error(
      "Refusing: remote database must use sslmode=verify-full or sslrootcert=system.",
    );
  return { databaseUrl: raw };
}

export function createOperatorClient(postgres, raw, applicationName) {
  const endpoint = parseDatabaseUrl(raw);
  const host = endpoint.host[0].toLowerCase().replace(/\.$/, "");
  if (!LOCAL_HOSTS.has(host) && endpoint.ssl !== "verify-full")
    throw new Error("Refusing: remote client requires verify-full TLS.");
  // Only parsed endpoint fields reach the driver: query parameters such as
  // sslrootcert must never become server startup parameters (Postgres 42704).
  // Bounded operator waits: finite server-enforced statement and lock budgets
  // on this CLI's own single connection, without changing global database
  // policy. A locked target fails the whole operation; never SKIP LOCKED and
  // never report success while a target row stays undeleted or active.
  return postgres({
    ...endpoint,
    host: [host],
    max: 1,
    connect_timeout: 10,
    debug: false,
    onnotice: () => {},
    target_session_attrs: "read-write",
    connection: {
      timezone: "UTC",
      search_path: "public",
      application_name: applicationName,
      statement_timeout: 10_000,
      lock_timeout: 5_000,
    },
  });
}

/**
 * Lock-timeout rollback (SQLSTATE 55P03): the bounded lock budget fired and
 * the transaction rolled back, so nothing was deleted or stamped. Callers map
 * this to a distinct retry message instead of the generic failure text.
 */
export function isLockTimeoutError(error) {
  return !!error && error.code === "55P03";
}
