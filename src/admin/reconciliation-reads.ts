// Dormant read model only; callers must provide authorization and audit before exposure.
import type postgres from "postgres";
import { diagnosticCode } from "../bot/diagnostic-code";
import { LEDGER_DB_TIMEOUT_MS } from "../jobs/constants";
import type { TxClient } from "../jobs/types";

export const RECONCILIATION_OPEN_LIMIT = 100;
export const RECONCILIATION_RESOLVED_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  idempotency_key: string;
  verb: string;
  subject: string;
  first_seen_at: Date | string;
  last_attempt_at: Date | string;
  attempts: number;
  last_code: string | null;
  last_status: number | null;
  resolved_at: Date | string | null;
  resolution: string | null;
};

// Drizzle leaves timestamp strings on its shared postgres.js client.
function readTimestamp(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

function project(row: Row) {
  return {
    idempotencyKey: row.idempotency_key,
    verb: row.verb,
    subject: /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,199}$/.test(row.subject) ? row.subject : null,
    firstSeenAt: readTimestamp(row.first_seen_at),
    lastAttemptAt: readTimestamp(row.last_attempt_at),
    attempts: row.attempts,
    lastCode: row.last_code === null ? null : diagnosticCode(row.last_code),
    lastStatus:
      Number.isInteger(row.last_status) && row.last_status! >= 100 && row.last_status! <= 599
        ? row.last_status
        : null,
    resolvedAt: row.resolved_at === null ? null : readTimestamp(row.resolved_at),
    resolution: ["confirmed", "not_applied", "superseded"].includes(row.resolution ?? "")
      ? row.resolution
      : null,
  };
}

/** No provider request IDs, actor IDs or free-text notes cross this boundary. */
export function pgReconciliationReads(sql: ReturnType<typeof postgres>) {
  async function bounded<T>(work: (tx: TxClient) => Promise<T>): Promise<T> {
    return sql.begin(async (transaction) => {
      const tx = transaction as unknown as TxClient;
      await tx`select set_config('lock_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true),
        set_config('statement_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true)`;
      return work(tx);
    }) as Promise<T>;
  }
  return {
    async listOpen() {
      return bounded(async (tx) => {
        const rows =
          (await tx`select idempotency_key, verb, subject, first_seen_at, last_attempt_at,
          attempts, last_code, last_status, resolved_at, resolution from bot_reconciliation_intents
          where resolved_at is null order by first_seen_at asc, idempotency_key asc
          limit ${RECONCILIATION_OPEN_LIMIT}`) as unknown as Row[];
        return rows.map(project);
      });
    },
    async listResolved() {
      return bounded(async (tx) => {
        const rows =
          (await tx`select idempotency_key, verb, subject, first_seen_at, last_attempt_at,
          attempts, last_code, last_status, resolved_at, resolution from bot_reconciliation_intents
          where resolved_at is not null order by resolved_at desc, idempotency_key asc
          limit ${RECONCILIATION_RESOLVED_LIMIT}`) as unknown as Row[];
        return rows.map(project);
      });
    },
    async get(key: string) {
      if (typeof key !== "string" || !UUID.test(key)) return null;
      return bounded(async (tx) => {
        const rows =
          (await tx`select idempotency_key, verb, subject, first_seen_at, last_attempt_at,
          attempts, last_code, last_status, resolved_at, resolution from bot_reconciliation_intents
          where idempotency_key = ${key}::uuid limit 1`) as unknown as Row[];
        return rows[0] ? project(rows[0]) : null;
      });
    },
  };
}
