import type { Sql, TransactionSql } from "postgres";
import { migrationLedgerMax, pendingWebMigrations } from "./up-migrations";
import { QUEUE_READ_TIMEOUT_MS, withTimeout } from "./up-timeout";

export type DatabaseReadiness = {
  db: "ok" | "error";
  pending_migrations: number | null;
  // Informational like `revision`, never part of the readiness verdict: the
  // maximum `created_at` in the migration ledger, or null when the database
  // read fails (or the ledger is empty). The production deploy gate reads it
  // to auto-promote when production was migrated out of band.
  migration_ledger_max: number | null;
};

export const HEALTH_STATEMENT_TIMEOUT_MS = 1000;
export const HEALTH_LOCK_TIMEOUT_MS = 750;
const HEALTH_RESPONSE_MARGIN_MS = 250;

// SET LOCAL belongs to the same reserved transaction as the read, not a pooled
// session. Closing a client alone does not cancel a lock-waiting backend.
// https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
// https://www.postgresql.org/docs/current/runtime-config-client.html#RUNTIME-CONFIG-CLIENT-STATEMENT
export async function withHealthReadTimeout<T>(
  sql: Sql,
  read: (tx: TransactionSql) => Promise<T>,
  deadline = Date.now() + QUEUE_READ_TIMEOUT_MS,
): Promise<T> {
  return (await sql.begin("read only", async (tx) => {
    const remaining = deadline - Date.now() - HEALTH_RESPONSE_MARGIN_MS;
    if (remaining <= 1) throw new Error("Health read deadline elapsed");
    const statement = Math.min(HEALTH_STATEMENT_TIMEOUT_MS, remaining);
    const lock = Math.min(HEALTH_LOCK_TIMEOUT_MS, statement - 1);
    await tx`SELECT set_config('statement_timeout', ${`${statement}ms`}, true),
      set_config('lock_timeout', ${`${lock}ms`}, true)`;
    // The successful setup reply can consume budget too. Refuse the read if
    // its installed server limit no longer fits; do not start another SET loop.
    if (statement > deadline - Date.now() - HEALTH_RESPONSE_MARGIN_MS)
      throw new Error("Health read deadline elapsed");
    return read(tx);
  })) as T;
}

export async function databaseReadiness(sql: Sql | null): Promise<DatabaseReadiness> {
  let db: DatabaseReadiness["db"] = "error";
  if (!sql) return { db, pending_migrations: null, migration_ledger_max: null };
  try {
    const deadline = Date.now() + QUEUE_READ_TIMEOUT_MS;
    const { pending_migrations, migration_ledger_max } = await withTimeout(
      (async () => {
        // Volatile clock_timestamp() prevents Hyperdrive query caching from
        // turning a cached ping/ledger into false readiness after an outage:
        // https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
        const ping = await withHealthReadTimeout(
          sql,
          async (tx) => tx`SELECT clock_timestamp() AS checked_at`,
          deadline,
        );
        if (ping.length !== 1) throw new Error("Missing database ping result");
        db = "ok";
        // Drizzle 0.45 records journal.when as created_at, not the filename/tag:
        // https://orm.drizzle.team/docs/drizzle-kit-migrate#applied-migrations-log-in-the-database
        const rows = await withHealthReadTimeout(
          sql,
          async (tx) => tx<{ created_at: unknown }[]>`
        SELECT created_at, clock_timestamp() AS checked_at FROM drizzle.__drizzle_migrations
      `,
          deadline,
        );
        // One ledger read feeds both signals; a malformed row fails both together.
        return {
          pending_migrations: pendingWebMigrations(rows),
          migration_ledger_max: migrationLedgerMax(rows),
        };
      })(),
      QUEUE_READ_TIMEOUT_MS,
    );
    return { db, pending_migrations, migration_ledger_max };
  } catch (err) {
    console.warn("Health check could not establish database/schema readiness.", {
      exception: err instanceof Error ? err.name : typeof err,
    });
    return { db, pending_migrations: null, migration_ledger_max: null };
  }
}
