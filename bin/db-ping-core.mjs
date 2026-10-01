import { isIP } from "node:net";

export const PROBE_TIMEOUT_MS = 5000;
export const CLEANUP_TIMEOUT_MS = 1000;

// Only explicit URL endpoint fields and a small TLS allowlist reach the driver.
// URL query parameters must not become connection/credential overrides.
export function parseDatabaseUrl(value) {
  if (typeof value !== "string" || !value || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error();
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) throw new Error();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host))) throw new Error();
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!username || !database || /[\u0000-\u001f\u007f]/u.test(username + password + database)
    || /[/\\]/u.test(database)) throw new Error();
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const seen = new Set();
  for (const [key, setting] of url.searchParams) {
    if (seen.has(key)) throw new Error();
    seen.add(key);
    if (key === "sslmode" && ["disable", "require", "verify-ca", "verify-full"].includes(setting)) continue;
    if (key === "sslrootcert" && setting === "system") continue;
    throw new Error();
  }
  const mode = url.searchParams.get("sslmode");
  const ssl = url.searchParams.has("sslrootcert") ? "verify-full"
    : !mode || mode === "disable" ? false : mode;
  return {
    // Arrays also prevent the driver's colon splitting from mangling IPv6.
    host: [host], port: [port], username, database,
    // postgres 3.4.9 uses `password || PGPASSWORD`: a function pins even "".
    password: () => password, ssl,
  };
}

const result = (code, exitCode = 1) => ({ ok: exitCode === 0, code, exitCode });
const timeout = Symbol("timeout");

async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeout), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDbPing({ databaseUrl, createClient,
  timeoutMs = PROBE_TIMEOUT_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS }) {
  let endpoint;
  try {
    endpoint = parseDatabaseUrl(databaseUrl);
    if (![timeoutMs, cleanupTimeoutMs].every(value => Number.isInteger(value) && value > 0)) throw new Error();
  } catch {
    return result("DB_PING_CONFIG", 2);
  }
  let sql;
  let outcome = result("DB_PING_FAILED");
  try {
    // One deadline includes lazy connection establishment and query execution.
    await bounded(async () => {
      sql = createClient({ ...endpoint, max: 1, fetch_types: false, prepare: false,
        connect_timeout: timeoutMs / 1000, idle_timeout: 1,
        connection: { application_name: "db-ping" },
        onnotice: () => {}, debug: false });
      await sql.unsafe("SELECT 1 AS ok");
    }, timeoutMs);
    outcome = result("DB_PING_OK", 0);
  } catch (error) {
    outcome = result(error === timeout ? "DB_PING_TIMEOUT" : "DB_PING_FAILED");
  } finally {
    if (sql) {
      try {
        // This client owns no writes. Destroy pending work rather than wait for
        // it to finish. Also bound completion if the driver itself gets stuck.
        // https://github.com/porsager/postgres#sqlend-timeout
        await bounded(() => sql.end({ timeout: 0 }), cleanupTimeoutMs);
      } catch (error) {
        outcome = result(error === timeout ? "DB_PING_CLEANUP_TIMEOUT" : "DB_PING_CLEANUP_FAILED");
      }
    }
  }
  return outcome;
}
