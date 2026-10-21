#!/usr/bin/env node
// Retained direct-postgres operator probe. DATABASE_URL is env-only; never
// argv or logs. Require an explicit host, user and database; default port 5432
// and empty password are pinned, not inherited from libpq environment settings.
// Optional URL settings: sslmode=disable|require|verify-ca|verify-full and
// sslrootcert=system. Refuse other/duplicate parameters and all CLI arguments
// except --help. Output: one stable JSON code, no driver details or rows. Exit 0 on success,
// 2 on configuration refusal, 1 on driver/deadline/cleanup failure. Driver console output is
// discarded. Connection plus query: 5s; cleanup: at most 1s more. No HTTP diagnostic is exposed.
import { parseDatabaseUrl, runDbPing } from "./db-ping-core.mjs";

const USAGE = `Usage: node bin/db-ping.mjs [--help]

Retained direct-postgres operator probe. Connection settings come from env
only, never argv.

Environment:
  DATABASE_URL  postgres URL with an explicit host, user and database
                (required). Default port 5432 and empty password are pinned,
                not inherited. Optional parameters: sslmode=disable|require|
                verify-ca|verify-full, sslrootcert=system. Other or duplicate
                parameters are refused.

Output: one JSON line ({ok, code}) on stdout when the probe succeeds, on
stderr otherwise. No driver details, no rows.

Exit codes:
  exit 0  probe succeeded (DB_PING_OK)
  exit 1  driver, deadline or cleanup failure (DB_PING_FAILED, DB_PING_TIMEOUT,
          DB_PING_CLEANUP_FAILED, DB_PING_CLEANUP_TIMEOUT)
  exit 2  configuration refusal: any CLI argument except --help, or a
          missing/invalid DATABASE_URL`;

async function main() {
  try {
    if (process.argv.length !== 2) throw new Error();
    parseDatabaseUrl(process.env.DATABASE_URL);
  } catch {
    return { ok: false, code: "DB_PING_CONFIG", exitCode: 2 };
  }
  // This standalone process owns its environment. Discard ambient libpq
  // settings before driver construction, including PGAPPNAME/PGSSLMODE.
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  // The driver prints some protocol errors (e.g. "Unknown Auth") straight to
  // the console; the only permitted output is the one JSON result below.
  for (const method of ["log", "info", "warn", "error", "debug", "trace"])
    console[method] = () => {};
  try {
    const { default: postgres } = await import("postgres");
    return await runDbPing({ databaseUrl: process.env.DATABASE_URL, createClient: postgres });
  } catch {
    return { ok: false, code: "DB_PING_FAILED", exitCode: 1 };
  }
}
if (process.argv.slice(2).includes("--help")) {
  // Discovery only: usage to stdout, exit 0, zero side effects — no config
  // read, no driver import, no probe. Checked before main() so --help is
  // never parsed as a positional refusal.
  process.stdout.write(`${USAGE}\n`, () => process.exit(0));
} else {
  const { exitCode, ...output } = await main();
  // Flush the one bounded result before exiting, even if a broken driver left
  // a socket/timer alive. runDbPing has already attempted bounded owned cleanup.
  const stream = output.ok ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(output)}\n`, () => process.exit(exitCode));
}
