#!/usr/bin/env node
// Retained direct-postgres operator probe. DATABASE_URL is env-only; never
// argv or logs. Require an explicit host, user and database; default port 5432
// and empty password are pinned, not inherited from libpq environment settings.
// Optional URL settings: sslmode=disable|require|verify-ca|verify-full and
// sslrootcert=system. Refuse other/duplicate parameters and all CLI arguments.
// Output: one stable JSON code, no driver details or rows. Exit 0 on success,
// 2 on configuration refusal, 1 on driver/deadline/cleanup failure. Connection
// plus query: 5s; cleanup: at most 1s more. No HTTP diagnostic is exposed.
import { parseDatabaseUrl, runDbPing } from "./db-ping-core.mjs";

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
  try {
    const { default: postgres } = await import("postgres");
    return await runDbPing({ databaseUrl: process.env.DATABASE_URL, createClient: postgres });
  } catch {
    return { ok: false, code: "DB_PING_FAILED", exitCode: 1 };
  }
}
const { exitCode, ...output } = await main();
// Flush the one bounded result before exiting, even if a broken driver left
// a socket/timer alive. runDbPing has already attempted bounded owned cleanup.
const stream = output.ok ? process.stdout : process.stderr;
stream.write(`${JSON.stringify(output)}\n`, () => process.exit(exitCode));
